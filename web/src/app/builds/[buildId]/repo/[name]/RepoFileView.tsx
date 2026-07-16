"use client";

// One file at the current revision. The version to show comes from the log
// the parent already fetched: its head entry is the path's state at the rev
// (add/modify = that blob; delete/empty = absent). Text renders through the
// shared SourceCode highlighter with the asset viewer's display cap; binary
// files get a download card (repo blobs are whole files, so no hex snippet).

import { useEffect, useState } from "react";
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

export default function RepoFileView({
  apiBase,
  path,
  log,
}: {
  apiBase: string;
  path: string;
  log: LogState;
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
      ) : (
        // Remount per blob so load state never bleeds across revisions.
        <TextBody key={entry.blob} url={url!} path={path} />
      )}
    </div>
  );
}
