"use client";

// Inline moderation for one extract: amend (field patch dialog) and
// reject/restore. Purely cosmetic gating — the PATCH and reject routes
// re-check credentials server-side.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EXTRACT_KINDS } from "@/lib/mag/kinds";
import { useModerator } from "@/components/useModerator";
import type { IssueExtractItem } from "./IssueBrowser";

interface FullText {
  text_original: string;
  text_en: string | null;
  summary_en: string | null;
  data: Record<string, unknown>;
}

export default function ModTools({ extract }: { extract: IssueExtractItem }) {
  const { moderator, token } = useModerator();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [dataText, setDataText] = useState("");

  if (!moderator) return null;

  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { "x-moderation-token": token } : {}),
  };

  async function openEditor() {
    setError(null);
    // The card only carries previews; edit the real thing.
    const r = await fetch(`/api/mag/extracts/${extract.id}`, { cache: "no-store" });
    if (!r.ok) {
      setError("could not load extract");
      return;
    }
    const { extract: full } = (await r.json()) as { extract: FullText & IssueExtractItem };
    setForm({
      kind: full.kind,
      section: full.section ?? "",
      title: full.title ?? "",
      language: full.language,
      text_original: full.text_original,
      text_en: full.text_en ?? "",
      summary_en: full.summary_en ?? "",
      content_warning: full.content_warning ?? "",
      is_fictional: full.is_fictional,
      sponsored: full.sponsored,
    });
    setDataText(JSON.stringify(full.data, null, 2));
    setOpen(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let data: unknown;
      try {
        data = dataText.trim() ? JSON.parse(dataText) : {};
      } catch {
        setError("data is not valid JSON");
        return;
      }
      const fields: Record<string, unknown> = {
        kind: form.kind,
        section: (form.section as string).trim() || null,
        title: (form.title as string).trim() || null,
        language: form.language,
        text_original: form.text_original,
        text_en: (form.text_en as string).trim() || null,
        summary_en: (form.summary_en as string).trim() || null,
        content_warning: (form.content_warning as string).trim() || null,
        is_fictional: !!form.is_fictional,
        sponsored: !!form.sponsored,
        data,
      };
      const r = await fetch(`/api/mag/extracts/${extract.id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ fields }),
      });
      if (!r.ok) {
        setError(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function setRejected(rejected: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/mag/extracts/${extract.id}/reject`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ rejected }),
      });
      if (!r.ok) {
        setError(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";

  return (
    <div className="mt-2 border-t border-dashed border-neutral-200 pt-2 dark:border-neutral-800">
      <div className="flex items-center gap-2 text-xs">
        <button onClick={openEditor} disabled={busy} className="text-sky-700 hover:underline dark:text-sky-300">
          Edit
        </button>
        {extract.status === "rejected" ? (
          <button onClick={() => setRejected(false)} disabled={busy} className="text-emerald-700 hover:underline dark:text-emerald-300">
            Restore
          </button>
        ) : (
          <button onClick={() => setRejected(true)} disabled={busy} className="text-red-700 hover:underline dark:text-red-300">
            Reject
          </button>
        )}
        {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
      </div>

      {open && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <div className="max-h-full w-full max-w-2xl overflow-y-auto rounded-md border border-neutral-300 bg-[var(--background)] p-4 dark:border-neutral-700">
            <h3 className="text-sm font-semibold">Amend extract #{extract.id}</h3>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <label className="block">
                <span className="text-xs text-neutral-500">kind</span>
                <select
                  value={form.kind as string}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                  className={input}
                >
                  {EXTRACT_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-neutral-500">section</span>
                <input value={form.section as string} onChange={(e) => setForm({ ...form, section: e.target.value })} className={input} />
              </label>
              <label className="col-span-2 block">
                <span className="text-xs text-neutral-500">title</span>
                <input value={form.title as string} onChange={(e) => setForm({ ...form, title: e.target.value })} className={input} />
              </label>
              <label className="block">
                <span className="text-xs text-neutral-500">language (bcp47)</span>
                <input value={form.language as string} onChange={(e) => setForm({ ...form, language: e.target.value })} className={input} />
              </label>
              <label className="block">
                <span className="text-xs text-neutral-500">content warning</span>
                <input
                  value={form.content_warning as string}
                  onChange={(e) => setForm({ ...form, content_warning: e.target.value })}
                  className={input}
                />
              </label>
              <label className="col-span-2 block">
                <span className="text-xs text-neutral-500">original text (verbatim)</span>
                <textarea
                  value={form.text_original as string}
                  onChange={(e) => setForm({ ...form, text_original: e.target.value })}
                  rows={6}
                  className={`${input} font-mono text-xs`}
                />
              </label>
              <label className="col-span-2 block">
                <span className="text-xs text-neutral-500">english text</span>
                <textarea
                  value={form.text_en as string}
                  onChange={(e) => setForm({ ...form, text_en: e.target.value })}
                  rows={4}
                  className={`${input} font-mono text-xs`}
                />
              </label>
              <label className="col-span-2 block">
                <span className="text-xs text-neutral-500">english summary</span>
                <textarea
                  value={form.summary_en as string}
                  onChange={(e) => setForm({ ...form, summary_en: e.target.value })}
                  rows={2}
                  className={input}
                />
              </label>
              <label className="col-span-2 block">
                <span className="text-xs text-neutral-500">structured data (JSON)</span>
                <textarea value={dataText} onChange={(e) => setDataText(e.target.value)} rows={6} className={`${input} font-mono text-xs`} />
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={!!form.is_fictional}
                  onChange={(e) => setForm({ ...form, is_fictional: e.target.checked })}
                />
                fictional
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={!!form.sponsored}
                  onChange={(e) => setForm({ ...form, sponsored: e.target.checked })}
                />
                sponsored
              </label>
            </div>
            {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <div className="mt-4 flex justify-end gap-2 text-sm">
              <button onClick={() => setOpen(false)} disabled={busy} className="rounded-md border border-neutral-300 px-3 py-1 dark:border-neutral-700">
                Cancel
              </button>
              <button
                onClick={save}
                disabled={busy}
                className="rounded-md bg-neutral-800 px-3 py-1 text-white disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
