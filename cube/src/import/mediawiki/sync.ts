/**
 * Continuous-sync worker: poll MediaWiki recentchanges and re-import the
 * touched pages through the converter. Pure orchestration: the caller binds
 * the site mapping into `convert` and owns storage via `save` (markdown null
 * means conversion failed and the raw wikitext should be stored as fallback).
 * All network access is injectable so the worker unit-tests offline.
 */

import type { ConversionResult } from "./types";
import { fetchParsoidHtml, fetchRawWikitext, type FetchedPage } from "./fetch";

export type SyncSaveInput = {
  title: string;
  /** Converted markdown, or null when conversion failed. */
  markdown: string | null;
  /** Raw wikitext of the revision (always fetched: history keeps MW syntax). */
  wikitext: string | null;
  /** The recent-change revision id (mw_rev_id provenance). */
  revId: number | null;
  /** The recent-change author (MW user name). */
  author: string;
  /** The recent-change edit summary. */
  comment: string;
  /** The recent-change ISO timestamp. */
  timestamp: string;
};

export type SyncFailure = {
  title: string;
  error: string;
  /** Timestamp of the change we failed on; clamps the sync cursor. */
  timestamp?: string;
};

export type SyncResult = {
  /** Pages fetched, converted, and saved without error. */
  processed: number;
  /** Newest change timestamp seen; pass as `since` on the next run. */
  newSince: string;
  failures: SyncFailure[];
};

export type SyncOptions = {
  baseUrl: string;
  /** MW ISO timestamp; changes at or after this instant are processed. */
  since: string;
  /** Site-bound converter (e.g. hpMapping + mapAsk closed over). */
  convert: (title: string, html: string) => ConversionResult;
  save: (input: SyncSaveInput) => Promise<void>;
  fetchHtml?: (baseUrl: string, title: string) => Promise<FetchedPage>;
  fetchWikitext?: (baseUrl: string, title: string) => Promise<string>;
  /** Fetches the recentchanges listing URL as JSON (injectable for tests). */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Max recent-change entries to page through per run. Default 500. */
  limit?: number;
};

type RecentChange = {
  ns?: number;
  title?: string;
  user?: string;
  comment?: string;
  timestamp?: string;
  revid?: number;
};

type RcResponse = {
  continue?: { rccontinue?: string };
  query?: { recentchanges?: RecentChange[] };
};

async function defaultFetchJson(url: string): Promise<unknown> {
  // Bound the request so the continuous-sync loop can't hang on a stalled peer.
  const res = await fetch(url, {
    headers: { "user-agent": "cube-import/0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`recentchanges ${res.status}`);
  return res.json();
}

/**
 * One sync pass: list changes since `since` (rcdir=newer, paged), dedupe
 * titles keeping the latest change, skip non-main namespaces (for now),
 * fetch + convert + save each page. Failures are collected, never fatal.
 */
export async function syncRecentChanges(opts: SyncOptions): Promise<SyncResult> {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const limit = opts.limit ?? 500;
  const base = opts.baseUrl.replace(/\/$/, "");

  const changes: RecentChange[] = [];
  let rccontinue: string | undefined;
  while (changes.length < limit) {
    const params = new URLSearchParams({
      action: "query",
      list: "recentchanges",
      rcprop: "title|timestamp|user|comment|ids",
      rclimit: "50",
      rcdir: "newer",
      rcstart: opts.since,
      format: "json",
    });
    if (rccontinue !== undefined) params.set("rccontinue", rccontinue);
    const body = (await fetchJson(`${base}/w/api.php?${params.toString()}`)) as RcResponse;
    const batch = body.query?.recentchanges ?? [];
    changes.push(...batch);
    rccontinue = body.continue?.rccontinue;
    if (rccontinue === undefined || batch.length === 0) break;
  }
  const considered = changes.slice(0, limit);

  // Dedupe per title, keeping the latest change; main namespace only for now.
  const byTitle = new Map<string, RecentChange>();
  for (const c of considered) {
    if (c.ns !== 0 || c.title === undefined) continue;
    const prev = byTitle.get(c.title);
    if (!prev || (c.timestamp ?? "") >= (prev.timestamp ?? "")) byTitle.set(c.title, c);
  }

  const failures: SyncFailure[] = [];
  let processed = 0;
  for (const [title, rc] of byTitle) {
    try {
      const { markdown, wikitext } = await fetchAndConvert({
        baseUrl: base,
        title,
        alwaysWikitext: true,
        convert: opts.convert,
        ...(opts.fetchHtml && { fetchHtml: opts.fetchHtml }),
        ...(opts.fetchWikitext && { fetchWikitext: opts.fetchWikitext }),
      });
      await opts.save({
        title,
        markdown,
        wikitext,
        revId: rc.revid ?? null,
        author: rc.user ?? "",
        comment: rc.comment ?? "",
        timestamp: rc.timestamp ?? "",
      });
      processed++;
    } catch (err) {
      failures.push({
        title,
        error: err instanceof Error ? err.message : String(err),
        timestamp: rc.timestamp,
      });
    }
  }

  // Advance the cursor over successfully-processed changes only: never to or
  // past the oldest change we failed to import, so a transient failure is
  // retried next pass instead of being silently skipped forever. rcstart is
  // inclusive with rcdir=newer, and imports are idempotent, so re-listing the
  // clamp point and later successes next pass is cheap.
  const oldestFailure = failures.reduce<string | undefined>(
    (min, f) => (f.timestamp && (min === undefined || f.timestamp < min) ? f.timestamp : min),
    undefined,
  );
  let newSince = opts.since;
  for (const c of considered) {
    const t = c.timestamp;
    if (t === undefined || t <= newSince) continue;
    if (oldestFailure !== undefined && t >= oldestFailure) continue;
    newSince = t;
  }

  return { processed, newSince, failures };
}

/* ---- shared one-page import step (also used by the batch importer) ---------- */

export type FetchConvertOptions = {
  baseUrl: string;
  title: string;
  convert: (title: string, html: string) => ConversionResult;
  fetchHtml?: (baseUrl: string, title: string) => Promise<FetchedPage>;
  fetchWikitext?: (baseUrl: string, title: string) => Promise<string>;
  /** Fetch wikitext even when conversion succeeds (two-step history import). */
  alwaysWikitext?: boolean;
};

export type FetchConvertResult = {
  /** Converted markdown, or null when conversion failed. */
  markdown: string | null;
  /** Raw wikitext, fetched only when markdown is null. */
  wikitext: string | null;
  result: ConversionResult;
};

export async function fetchAndConvert(opts: FetchConvertOptions): Promise<FetchConvertResult> {
  const fetchHtml = opts.fetchHtml ?? fetchParsoidHtml;
  const fetchWikitext = opts.fetchWikitext ?? fetchRawWikitext;
  const page = await fetchHtml(opts.baseUrl, opts.title);
  const result = opts.convert(opts.title, page.html);
  const wikitext =
    result.markdown === null || opts.alwaysWikitext
      ? await fetchWikitext(opts.baseUrl, opts.title)
      : null;
  return { markdown: result.markdown, wikitext, result };
}
