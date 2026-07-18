"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { BuildNoteRow } from "@/lib/media";

interface Viewer {
  name?: string;
  moderator: boolean;
}

interface Props {
  sha256: string;
  notes: BuildNoteRow[];
  skipped: boolean;
}

// Community notes: plain text, attributed, editable by their author or a
// moderator. Gating here is cosmetic: the routes re-check server-side.
export default function NotesSection({ sha256, notes, skipped }: Props) {
  const router = useRouter();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

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
  const skipEmpty = skipped && notes.length === 0;

  async function call(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(path, init);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setNote(`Error: ${j.error ?? res.statusText}`);
        return false;
      }
      router.refresh();
      return true;
    } catch (e) {
      setNote(`Failed: ${e}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const add = async () => {
    if (!draft.trim()) return;
    if (
      await call(`/api/build/${sha256}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft.trim() }),
      })
    ) {
      setDraft("");
    }
  };

  const saveEdit = async (id: number) => {
    if (!editDraft.trim()) return;
    if (
      await call(`/api/build/${sha256}/notes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: editDraft.trim() }),
      })
    ) {
      setEditing(null);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="text-lg font-medium">
        Notes {notes.length > 0 && <span className="text-sm font-normal text-neutral-400">({notes.length})</span>}
      </h2>
      {skipEmpty ? (
        <p className="mt-2 text-xs text-neutral-400" title="Marked not applicable">
          Skipped
        </p>
      ) : (
        notes.length === 0 && <p className="mt-2 text-xs text-neutral-400">None yet.</p>
      )}
      <ul className="mt-3 grid max-w-3xl gap-3">
        {notes.map((n) => {
          const canEdit = !!viewer && (viewer.moderator || (!!viewer.name && viewer.name === n.author));
          return (
            <li key={n.id} className="rounded-md border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
              {editing === n.id ? (
                <div className="grid gap-2">
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 outline-none focus:border-neutral-500 dark:border-neutral-700"
                  />
                  <div className="flex gap-2 text-xs">
                    <button
                      onClick={() => saveEdit(n.id)}
                      disabled={busy || !editDraft.trim()}
                      className="rounded-md border border-neutral-300 px-2 py-1 font-medium hover:border-neutral-500 disabled:opacity-40 dark:border-neutral-700"
                    >
                      Save
                    </button>
                    <button onClick={() => setEditing(null)} className="text-neutral-500 hover:underline">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="whitespace-pre-wrap break-words">{n.body}</p>
                  <p className="mt-2 flex items-baseline gap-2 text-xs text-neutral-500">
                    <span className="font-medium">{n.author}</span>
                    <span className="text-neutral-400">{n.created_at.slice(0, 10)}</span>
                    {n.edited_at && <span className="text-neutral-400">(edited)</span>}
                    {canEdit && (
                      <>
                        <button
                          onClick={() => {
                            setEditing(n.id);
                            setEditDraft(n.body);
                          }}
                          className="text-neutral-400 hover:underline"
                        >
                          edit
                        </button>
                        <button
                          onClick={() => call(`/api/build/${sha256}/notes/${n.id}`, { method: "DELETE" })}
                          disabled={busy}
                          className="text-neutral-400 hover:text-red-500"
                        >
                          delete
                        </button>
                      </>
                    )}
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {skipEmpty ? null : loggedIn ? (
        <div className="mt-4 grid max-w-3xl gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Add a note about this build…"
            className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
          />
          <div>
            <button
              onClick={add}
              disabled={busy || !draft.trim()}
              className="rounded-md border border-neutral-300 px-3 py-1 text-sm font-medium hover:border-neutral-500 disabled:opacity-40 dark:border-neutral-700"
            >
              Add note
            </button>
          </div>
        </div>
      ) : (
        viewer && <p className="mt-2 text-xs text-neutral-500">Log in to the wiki to add a note.</p>
      )}
      {note && <p className="mt-2 text-xs text-neutral-500">{note}</p>}
    </section>
  );
}
