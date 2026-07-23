"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BuildMediaView, MediaKind, MediaLabel, SkipFlags } from "@/lib/media";

interface Viewer {
  name?: string;
  moderator: boolean;
}

interface Upload {
  key: number;
  label: string;
  pct: number;
  error?: string;
}

interface Props {
  sha256: string;
  items: BuildMediaView[];
  skips: SkipFlags;
}

const CHUNK = 8 * 1024 * 1024;

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
export default function MediaSection({ sha256, items, skips }: Props) {
  const router = useRouter();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [note, setNote] = useState("");
  const nextKey = useRef(1);

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

  const loggedIn = !!viewer?.name || !!viewer?.moderator;

  const patchUpload = (key: number, patch: Partial<Upload>) =>
    setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function uploadFile(file: File, kind: MediaKind) {
    const key = nextKey.current++;
    setUploads((u) => [...u, { key, label: file.name, pct: 0 }]);
    try {
      const create = await fetch(`/api/build/${sha256}/media/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, filename: file.name, size: file.size }),
      });
      const cj = await create.json().catch(() => ({}));
      if (!create.ok) throw new Error(cj.error ?? create.statusText);

      let offset = 0;
      let stalls = 0;
      for (;;) {
        const end = Math.min(offset + CHUNK, file.size);
        const res = await fetch(`/api/build/${sha256}/media/upload/${cj.token}?offset=${offset}`, {
          method: "PUT",
          body: file.slice(offset, end),
        });
        const j = await res.json().catch(() => ({}));
        if (res.status === 409 && typeof j.offset === "number") {
          if (++stalls > 3 && j.offset <= offset) throw new Error("upload stalled");
          offset = j.offset;
          continue;
        }
        if (!res.ok) throw new Error(j.error ?? res.statusText);
        if (j.done) break;
        offset = typeof j.offset === "number" ? j.offset : end;
        patchUpload(key, { pct: offset / file.size });
      }
      setUploads((u) => u.filter((x) => x.key !== key));
      router.refresh();
    } catch (e) {
      patchUpload(key, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function remove(id: number) {
    setNote("");
    const res = await fetch(`/api/build/${sha256}/media/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setNote(`Error: ${j.error ?? res.statusText}`);
      return;
    }
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
                    onFiles={(files) => files.forEach((f) => uploadFile(f, s.kind))}
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
                      <Caption item={m} viewer={viewer} onDelete={() => remove(m.id)} />
                    </figure>
                  ))}
                </div>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  {mine.map((m) => (
                    <figure key={m.id}>
                      <a href={m.url} target="_blank" rel="noreferrer">
                        {/* Physical photos are multi-MB scans; draw the cell from the
                            server-scaled thumb (2x the cell, lanczos) instead of making
                            the browser downsample the original. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={s.kind === "physical" ? `/api/media/${m.sha256}/thumb?w=500` : m.url}
                          alt={m.filename}
                          loading="lazy"
                          className={`${s.kind === "physical" ? "aspect-square" : "h-36"} w-full rounded-md border border-neutral-200 object-cover dark:border-neutral-800`}
                        />
                      </a>
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
                  <button
                    onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}
                    className="text-neutral-400 hover:text-neutral-600"
                  >
                    dismiss
                  </button>
                </>
              ) : (
                <>
                  <progress value={u.pct} max={1} className="h-1.5 w-40" />
                  <span className="tabular-nums">{Math.round(u.pct * 100)}%</span>
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
