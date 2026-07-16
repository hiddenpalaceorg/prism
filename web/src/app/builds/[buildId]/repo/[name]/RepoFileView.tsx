"use client";

// One file at the current revision. The version to show comes from the log
// the parent already fetched: its head entry is the path's state at the rev
// (add/modify = that blob; delete/empty = absent). Text renders through the
// shared SourceCode highlighter with the asset viewer's display cap; binary
// files get a download card (repo blobs are whole files, so no hex snippet).
// A header toggle swaps text files into blame mode: a light gutter of
// date + author per run of lines from the same commit (the blame route's
// hunks), clicking through to that change's diff.

import { Fragment, useEffect, useState } from "react";
import { blameHunks, type BlameDto } from "@/lib/blame";
import { splitLines } from "@/lib/linediff";
import { formatCommitDate, type RepoLogEntryDto } from "@/lib/repo-manifest";
import SourceCode from "../../SourceCode";
import type { LogState } from "./RepoViewer";

// Same cap as the asset viewer: a 20MB DOM node makes the tab crawl.
const TEXT_DISPLAY_CAP = 1_000_000;

function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} B` : `${v.toFixed(1)} ${units[i]}`;
}

function TextBody({ url, path }: { url: string; path: string }) {
  const [state, setState] = useState<{ text: string; truncated: boolean } | "loading" | "error">("loading");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const text = new TextDecoder().decode(buf.slice(0, TEXT_DISPLAY_CAP));
        if (!cancelled) setState({ text, truncated: buf.byteLength > TEXT_DISPLAY_CAP });
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state === "loading") return <p className="p-6 text-sm text-neutral-400">Loading…</p>;
  if (state === "error") return <p className="p-6 text-sm text-red-500">Failed to load file.</p>;
  return (
    <div className="p-4">
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-neutral-800 dark:text-neutral-200">
        <SourceCode path={path} text={state.text} />
      </pre>
      {state.truncated && (
        <p className="mt-3 text-xs text-neutral-400">Preview truncated — download for the full file.</p>
      )}
    </div>
  );
}

function BlameBody({
  apiBase,
  path,
  entry,
  onSelectDiff,
}: {
  apiBase: string;
  path: string;
  entry: RepoLogEntryDto;
  onSelectDiff: (oid: string) => void;
}) {
  // Text and blame load independently: blame can 400 (file too large, chain
  // too long) while the text is fine, and then the plain view still shows.
  const [text, setText] = useState<{ text: string; truncated: boolean } | "loading" | "error">("loading");
  const [blame, setBlame] = useState<BlameDto | "loading" | "error">("loading");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/blob/${entry.blob}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        // Blame rejects files over the cap, so truncation only ever shows in
        // the fallback below — a blamed file is always whole.
        const decoded = new TextDecoder().decode(buf.slice(0, TEXT_DISPLAY_CAP));
        if (!cancelled) setText({ text: decoded, truncated: buf.byteLength > TEXT_DISPLAY_CAP });
      } catch {
        if (!cancelled) setText("error");
      }
    })();
    (async () => {
      try {
        // Keyed on the head log entry's commit, not the viewer's rev: every
        // rev sharing this file version shares the immutable cached response.
        const res = await fetch(`${apiBase}/blame?rev=${entry.oid}&path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: BlameDto = await res.json();
        if (!cancelled) setBlame(data);
      } catch {
        if (!cancelled) setBlame("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, path, entry.oid, entry.blob]);

  if (text === "loading" || blame === "loading")
    return <p className="p-6 text-sm text-neutral-400">Loading…</p>;
  if (text === "error") return <p className="p-6 text-sm text-red-500">Failed to load file.</p>;

  const lines = splitLines(text.text);
  if (blame === "error" || blame.lines.length !== lines.length) {
    return (
      <div className="p-4">
        <p className="mb-3 text-xs text-neutral-400">Blame is unavailable for this file.</p>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-neutral-800 dark:text-neutral-200">
          <SourceCode path={path} text={text.text} />
        </pre>
        {text.truncated && (
          <p className="mt-3 text-xs text-neutral-400">Preview truncated — download for the full file.</p>
        )}
      </div>
    );
  }
  if (lines.length === 0) return <p className="p-6 text-sm text-neutral-500">Empty file.</p>;

  // The gutter cell spans its hunk's rows; number/code cells auto-flow into
  // the columns beside it. Borders mark hunk starts across the whole row.
  const sep = "border-t border-neutral-100 dark:border-neutral-900";
  return (
    <div className="p-3 text-xs leading-5">
      <div className="grid grid-cols-[minmax(0,11rem)_2.75rem_minmax(0,1fr)]">
        {blameHunks(blame.lines).map((h) => {
          const c = blame.commits[h.commit];
          return (
            <Fragment key={h.start}>
              <button
                style={{ gridRow: `span ${h.len}` }}
                onClick={() => onSelectDiff(c.oid)}
                title={`${c.subject || "(no message)"} · ${c.author.name} · ${formatCommitDate(c.author)}`}
                className={`flex min-w-0 items-start gap-2 pr-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900/40 ${sep}`}
              >
                <span className="shrink-0 font-mono text-neutral-500">
                  {formatCommitDate(c.author).slice(0, 10)}
                </span>
                <span className="min-w-0 truncate text-neutral-400">{c.author.name}</span>
              </button>
              {lines.slice(h.start, h.start + h.len).map((s, i) => (
                <Fragment key={h.start + i}>
                  <span
                    className={`select-none px-2 text-right font-mono text-neutral-300 dark:text-neutral-600 ${i === 0 ? sep : ""}`}
                  >
                    {h.start + i + 1}
                  </span>
                  <span
                    className={`whitespace-pre-wrap break-words font-mono text-neutral-800 dark:text-neutral-200 ${i === 0 ? sep : ""}`}
                  >
                    {s}
                  </span>
                </Fragment>
              ))}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

export default function RepoFileView({
  apiBase,
  path,
  log,
  blame,
  onToggleBlame,
  onSelectDiff,
}: {
  apiBase: string;
  path: string;
  log: LogState;
  blame: boolean;
  onToggleBlame: () => void;
  onSelectDiff: (oid: string) => void;
}) {
  const name = path.split("/").pop() || path;

  if (log === "loading") return <p className="p-6 text-sm text-neutral-400">Loading…</p>;
  if (log === "error") return <p className="p-6 text-sm text-red-500">Failed to load file history.</p>;

  const head = log[0];
  const entry = head && head.change !== "delete" && head.blob ? head : null;
  const url = entry ? `${apiBase}/blob/${entry.blob}?name=${encodeURIComponent(name)}` : null;

  return (
    <div className="rounded border border-neutral-200 dark:border-neutral-800">
      {/* Sticks to the top of the scrolling main column. */}
      <div className="sticky top-0 z-10 flex items-center gap-3 rounded-t border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {path}
        </span>
        {entry && entry.size !== null && (
          <span className="shrink-0 text-xs text-neutral-500">{humanSize(entry.size)}</span>
        )}
        {entry && !entry.binary && (
          <button
            onClick={onToggleBlame}
            className={`shrink-0 text-xs ${
              blame ? "font-medium text-sky-600 dark:text-sky-400" : "text-neutral-500 hover:underline"
            }`}
          >
            Blame
          </button>
        )}
        {url && (
          <a href={url} download={name} className="shrink-0 text-xs text-neutral-500 hover:underline">
            Download
          </a>
        )}
      </div>
      {entry === null ? (
        <p className="p-6 text-sm text-neutral-500">
          {log.length === 0
            ? "This path does not exist at this revision."
            : "This file was deleted as of this revision."}
        </p>
      ) : entry.binary ? (
        <div className="flex flex-col items-center gap-3 p-10 text-sm text-neutral-500">
          <p>Binary file — no inline preview.</p>
          <a
            href={url!}
            download={name}
            className="rounded bg-neutral-100 px-3 py-1.5 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            Download {name}
          </a>
        </div>
      ) : blame ? (
        // Remount per version so load state never bleeds across revisions.
        <BlameBody key={entry.oid} apiBase={apiBase} path={path} entry={entry} onSelectDiff={onSelectDiff} />
      ) : (
        <TextBody key={entry.blob} url={url!} path={path} />
      )}
    </div>
  );
}
