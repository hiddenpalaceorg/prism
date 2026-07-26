"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BuildMediaView, MediaKind, MediaLabel, SkipFlags } from "@/lib/media";
import { MediaThumb, useMedia } from "./MediaViewerHost";

interface Viewer {
  name?: string;
  moderator: boolean;
}

interface Upload {
  key: number;
  label: string;
  pct: number;
  /** Waiting for a slot in the upload window. */
  queued: boolean;
  /** Set while backing off between attempts, e.g. "retrying 2/6". */
  retry?: string;
  error?: string;
}

/** What a failed upload needs to pick up where it stopped. The token is kept
 *  because the session on the server still holds the bytes already sent: a
 *  retry resumes at that offset instead of re-uploading from zero. */
interface Job {
  key: number;
  file: File;
  kind: MediaKind;
  token?: string;
}

interface Props {
  sha256: string;
  skips: SkipFlags;
}

const CHUNK = 8 * 1024 * 1024;

// How many files upload at once. The bottleneck is one person's uplink, so a
// wider window does not finish the batch sooner. It just makes every file
// slower and every request likelier to sit past a proxy timeout. Picking 20
// photos used to start 20 streams at once, which is where "flaky with several
// files" came from.
const CONCURRENCY = 3;

// Every request in this protocol is safe to repeat: a chunk the server already
// has answers 409 with the true offset, and a session whose row exists replays
// its reply. So a dropped connection, a rate-limit reply, or a slot restarting
// mid-deploy is worth waiting out rather than losing the file for.
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 700;
const RETRY_CAP_MS = 15_000;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

// One refresh once the batch settles, not one per file: concurrent refreshes
// race, and the loser can be an older payload that drops just-uploaded items
// back off the page.
const REFRESH_DEBOUNCE_MS = 800;

// A 409 moves the client to whatever the server actually holds, in either
// direction (a chunk that never landed rewinds it). That makes a plain
// monotonic check the wrong guard, so a run of them with no chunk accepted in
// between is what counts as going nowhere.
const MAX_STALLS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An upload that stopped. `resumable` false means the server rejected the
 *  file outright (format, size, permission) and dropped the session with it,
 *  so there is nothing left to offer to resume. */
class UploadError extends Error {
  constructor(
    message: string,
    readonly resumable: boolean
  ) {
    super(message);
  }
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 60_000);
  // Jittered, so files that tripped the same limit together do not all come
  // back in lockstep and trip it again.
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS) * (0.5 + Math.random());
}

/** fetch that rides out the failures the resume protocol exists to absorb.
 *  Returns the first reply that is not a transient failure (and the last one
 *  when the attempts run out, so the caller reports the server's own error),
 *  throws only when the request could not be made at all. */
async function sendWithRetry(
  url: string,
  init: RequestInit,
  onRetry: (note: string) => void
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt + 1 >= MAX_ATTEMPTS;
    try {
      const res = await fetch(url, init);
      if (!RETRYABLE.has(res.status) || last) return res;
      onRetry(`retrying ${attempt + 2}/${MAX_ATTEMPTS}`);
      await sleep(retryDelay(attempt, res.headers.get("retry-after")));
    } catch (e) {
      if (last) throw e instanceof Error ? e : new Error(String(e));
      onRetry(`retrying ${attempt + 2}/${MAX_ATTEMPTS}`);
      await sleep(retryDelay(attempt, null));
    }
  }
}

const SECTIONS: Array<{
  kind: MediaKind;
  title: string;
  accept: string;
  add: string;
  multiple: boolean;
  skipKey: keyof SkipFlags;
}> = [
  {
    kind: "screenshot",
    title: "Screenshots",
    accept: "image/png,image/jpeg,image/webp,image/gif",
    add: "Add screenshots",
    multiple: true,
    skipKey: "skip_screenshots",
  },
  {
    kind: "video",
    title: "Video",
    accept: "video/mp4,video/webm",
    add: "Add video",
    multiple: false,
    skipKey: "skip_video",
  },
  {
    kind: "physical",
    title: "Physical media",
    accept: "image/png,image/jpeg,image/webp,image/gif",
    add: "Add photos",
    multiple: true,
    skipKey: "skip_physical",
  },
];

// Community media gallery + uploader. Uploads go in 8MB chunks (the chunk
// route resumes on 409), so even long captures pass the proxy body limit.
// Gating here is cosmetic: the routes re-check the wiki session server-side.
//
// A finished file is drawn from the row the upload itself returned, not from a
// re-render of the page. The build page is ISR-cached and served by either app
// slot, so waiting on a refresh to see your own upload is a race the uploader
// used to lose often enough that a hard reload was the reliable way to see it.
// That reconciliation lives in MediaViewerHost, which owns the list this draws.
export default function MediaSection({ sha256, skips }: Props) {
  const router = useRouter();
  const { items, open, add, drop, patch } = useMedia();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [note, setNote] = useState("");
  const nextKey = useRef(1);
  const queue = useRef<Job[]>([]);
  const failed = useRef(new Map<number, Job>());
  const running = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/whoami", { cache: "no-store" })
      .then((r) => r.json())
      .then((w) => !cancelled && setViewer({ name: w.name, moderator: !!w.moderator }))
      .catch(() => !cancelled && setViewer({ moderator: false }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => void (refreshTimer.current && clearTimeout(refreshTimer.current)), []);

  const loggedIn = !!viewer?.name || !!viewer?.moderator;

  const patchUpload = (key: number, patch: Partial<Upload>) =>
    setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  function scheduleRefresh() {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      router.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  function enqueue(jobs: Job[]) {
    queue.current.push(...jobs);
    pump();
  }

  function pump() {
    while (running.current < CONCURRENCY && queue.current.length > 0) {
      const job = queue.current.shift()!;
      running.current++;
      patchUpload(job.key, { queued: false });
      void runJob(job).finally(() => {
        running.current--;
        pump();
      });
    }
  }

  async function runJob(job: Job) {
    const { key, file, kind } = job;
    const onRetry = (retry: string) => patchUpload(key, { retry });
    try {
      let token = job.token;
      if (!token) {
        // A create that succeeded but whose reply was lost is retried here and
        // opens a second session. The orphan holds no bytes and the reaper
        // clears it. Losing the file instead would be the worse trade.
        const create = await sendWithRetry(
          `/api/build/${sha256}/media/upload`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind, filename: file.name, size: file.size }),
          },
          onRetry
        );
        const cj = await create.json().catch(() => ({}));
        if (!create.ok) throw new UploadError(cj.error ?? create.statusText, create.status >= 500);
        token = cj.token as string;
        job.token = token; // a later retry resumes this session
      }

      let offset = 0;
      let stalls = 0;
      let media: BuildMediaView | undefined;
      for (;;) {
        patchUpload(key, { retry: undefined });
        const end = Math.min(offset + CHUNK, file.size);
        const res = await sendWithRetry(
          `/api/build/${sha256}/media/upload/${token}?offset=${offset}`,
          { method: "PUT", body: file.slice(offset, end) },
          onRetry
        );
        const j = await res.json().catch(() => ({}));
        if (res.status === 409 && typeof j.offset === "number") {
          if (++stalls > MAX_STALLS) throw new UploadError("upload stalled", true);
          offset = j.offset;
          patchUpload(key, { pct: offset / file.size });
          continue;
        }
        if (!res.ok) {
          // Resumable only if the session survived: a 4xx here is the server
          // refusing the file itself, and it drops the session saying so.
          throw new UploadError(j.error ?? res.statusText, res.status >= 500 || res.status === 429);
        }
        stalls = 0;
        if (j.done) {
          media = j.media as BuildMediaView | undefined;
          break;
        }
        offset = typeof j.offset === "number" ? j.offset : end;
        patchUpload(key, { pct: offset / file.size });
      }
      // Finalised without a row: nothing to draw, and resuming is right, because
      // the session replays its answer once it has one.
      if (!media) throw new UploadError("upload finished without a record", true);

      failed.current.delete(key);
      setUploads((u) => u.filter((x) => x.key !== key));
      add(media);
      scheduleRefresh();
    } catch (e) {
      if (!(e instanceof UploadError) || e.resumable) failed.current.set(key, job);
      patchUpload(key, { retry: undefined, error: e instanceof Error ? e.message : String(e) });
    }
  }

  function start(files: File[], kind: MediaKind) {
    const jobs: Job[] = [];
    const rows: Upload[] = [];
    for (const file of files) {
      const key = nextKey.current++;
      if (file.size === 0) {
        rows.push({ key, label: file.name, pct: 0, queued: false, error: "file is empty" });
        continue;
      }
      jobs.push({ key, file, kind });
      rows.push({ key, label: file.name, pct: 0, queued: true });
    }
    setUploads((u) => [...u, ...rows]);
    enqueue(jobs);
  }

  function retryUpload(key: number) {
    const job = failed.current.get(key);
    if (!job) return;
    failed.current.delete(key);
    patchUpload(key, { error: undefined, retry: undefined, queued: true });
    enqueue([job]);
  }

  async function remove(id: number) {
    setNote("");
    const res = await fetch(`/api/build/${sha256}/media/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setNote(`Error: ${j.error ?? res.statusText}`);
      return;
    }
    drop(id);
    router.refresh();
  }

  async function relabel(id: number, label: MediaLabel) {
    setNote("");
    const res = await fetch(`/api/build/${sha256}/media/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setNote(`Error: ${j.error ?? res.statusText}`);
      return;
    }
    patch(id, { label });
    router.refresh();
  }

  const total = items.length;
  return (
    <section className="mt-8">
      <h2 className="text-lg font-medium">
        Media {total > 0 && <span className="text-sm font-normal text-neutral-400">({total})</span>}
      </h2>
      {!loggedIn && viewer && (
        <p className="mt-1 text-xs text-neutral-500">Log in to the wiki to add screenshots, video, or photos.</p>
      )}
      <div className="mt-3 grid gap-8">
        {SECTIONS.map((s) => {
          const mine = items.filter((m) => m.kind === s.kind);
          const skipped = skips[s.skipKey] && mine.length === 0;
          return (
            <div key={s.kind}>
              <div className="flex items-center gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{s.title}</h3>
                {loggedIn && !skipped && (
                  <AddButton
                    label={s.add}
                    accept={s.accept}
                    multiple={s.multiple}
                    onFiles={(files) => start(files, s.kind)}
                  />
                )}
              </div>
              {skipped ? (
                <p className="mt-2 text-xs text-neutral-400" title="Marked not applicable">
                  Skipped
                </p>
              ) : mine.length === 0 ? (
                <p className="mt-2 text-xs text-neutral-400">None yet.</p>
              ) : s.kind === "video" ? (
                <div className="mt-2 grid gap-4 sm:grid-cols-2">
                  {mine.map((m) => (
                    <figure key={m.id}>
                      <video
                        controls
                        preload="none"
                        poster={m.posterUrl ?? undefined}
                        src={m.url}
                        className="max-h-80 w-full rounded-md border border-neutral-200 bg-black dark:border-neutral-800"
                      />
                      {/* The player takes the clicks here, so it is the filename
                          that opens the gallery (same as the asset cards). */}
                      <button
                        onClick={() => open(m.id)}
                        title={m.filename}
                        className="mt-1 block w-0 min-w-full truncate text-left font-mono text-[11px] text-sky-700 hover:underline dark:text-sky-400"
                      >
                        {m.filename}
                      </button>
                      <Caption item={m} viewer={viewer} onDelete={() => remove(m.id)} />
                    </figure>
                  ))}
                </div>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  {mine.map((m) => (
                    <figure key={m.id}>
                      {/* Physical photos are multi-MB scans; the cell draws from
                          the server-scaled thumb (2x the cell, lanczos) and the
                          full image loads only once the gallery opens it. */}
                      <MediaThumb
                        item={m}
                        width={s.kind === "physical" ? 500 : undefined}
                        wrapClassName="block w-full"
                        className={`${s.kind === "physical" ? "aspect-square" : "h-36"} w-full rounded-md border border-neutral-200 object-cover hover:border-sky-400 dark:border-neutral-800 dark:hover:border-sky-600`}
                      />
                      <Caption
                        item={m}
                        viewer={viewer}
                        onDelete={() => remove(m.id)}
                        onLabel={s.kind === "physical" ? (label) => relabel(m.id, label) : undefined}
                      />
                    </figure>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {uploads.length > 0 && (
        <ul className="mt-4 grid gap-1 text-xs text-neutral-500">
          {uploads.map((u) => (
            <li key={u.key} className="flex items-center gap-2">
              <span className="max-w-64 truncate">{u.label}</span>
              {u.error ? (
                <>
                  <span className="text-red-500">{u.error}</span>
                  {failed.current.has(u.key) && (
                    <button
                      onClick={() => retryUpload(u.key)}
                      title="Resume from where it stopped"
                      className="text-neutral-400 hover:text-neutral-600"
                    >
                      retry
                    </button>
                  )}
                  <button
                    onClick={() => {
                      failed.current.delete(u.key);
                      setUploads((x) => x.filter((y) => y.key !== u.key));
                    }}
                    className="text-neutral-400 hover:text-neutral-600"
                  >
                    dismiss
                  </button>
                </>
              ) : u.queued ? (
                <span className="text-neutral-400">queued</span>
              ) : (
                <>
                  <progress value={u.pct} max={1} className="h-1.5 w-40" />
                  <span className="tabular-nums">{Math.round(u.pct * 100)}%</span>
                  {u.retry && <span className="text-amber-600 dark:text-amber-500">{u.retry}</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="mt-2 text-xs text-neutral-500">{note}</p>}
    </section>
  );
}

function AddButton({
  label,
  accept,
  multiple,
  onFiles,
}: {
  label: string;
  accept: string;
  multiple: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        onClick={() => input.current?.click()}
        className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs font-medium hover:border-neutral-500 dark:border-neutral-700"
      >
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </>
  );
}

// Options hardcoded (not imported from lib/media, whose value exports drag
// node builtins into the client bundle). Kept in sync with MEDIA_LABELS.
const LABELS: Array<{ value: MediaLabel; text: string }> = [
  { value: "front", text: "Front" },
  { value: "back", text: "Back" },
  { value: "other", text: "Other" },
];

function Caption({
  item,
  viewer,
  onDelete,
  onLabel,
}: {
  item: BuildMediaView;
  viewer: Viewer | null;
  onDelete: () => void;
  /** Physical photos only: change the front/back/other label. */
  onLabel?: (label: MediaLabel) => void;
}) {
  const canEdit = !!viewer && (viewer.moderator || (!!viewer.name && viewer.name === item.author));
  const label = item.label ?? "other";
  return (
    <figcaption className="mt-1 flex items-baseline gap-2 text-xs text-neutral-500">
      {onLabel &&
        (canEdit ? (
          <select
            value={label}
            onChange={(e) => onLabel(e.target.value as MediaLabel)}
            title="What the photo shows"
            className="shrink-0 rounded border border-neutral-200 bg-transparent px-1 dark:border-neutral-800"
          >
            {LABELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.text}
              </option>
            ))}
          </select>
        ) : (
          <span className="shrink-0">{LABELS.find((l) => l.value === label)?.text}</span>
        ))}
      <span className="min-w-0 truncate" title={item.filename}>
        {item.author}
      </span>
      <span className="shrink-0 text-neutral-400">{item.created_at.slice(0, 10)}</span>
      {canEdit && (
        <button onClick={onDelete} title="Remove" className="shrink-0 text-neutral-400 hover:text-red-500">
          ×
        </button>
      )}
    </figcaption>
  );
}
