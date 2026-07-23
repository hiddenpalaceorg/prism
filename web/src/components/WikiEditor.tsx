"use client";

// Source-mode wiki editor: textarea + live validation (the real save-pipeline
// validator via /api/cube/validate) + save with conflict handling. The visual
// TipTap editor mounts on top of this same save plumbing later.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { hpComponents } from "@/cube/schemas";

// TipTap only loads when the visual mode is opened.
const VisualEditor = dynamic(() => import("./VisualEditor"), {
  ssr: false,
  loading: () => <div className="py-12 text-center text-sm text-neutral-500">Loading visual editor...</div>,
});

type Issue = {
  severity: "error" | "warning";
  rule: string;
  message: string;
  line?: number;
  column?: number;
};

type Props = {
  title: string;
  canonicalHref: string;
  initialMarkdown: string;
  baseRevision: number | null;
  isNew: boolean;
};

export default function WikiEditor({ title, canonicalHref, initialMarkdown, baseRevision, isNew }: Props) {
  const router = useRouter();
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [mode, setMode] = useState<"source" | "visual">("source");
  const [comment, setComment] = useState("");
  const [minor, setMinor] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ head: number } | null>(null);
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validate = useCallback(
    (text: string) => {
      if (validateTimer.current) clearTimeout(validateTimer.current);
      validateTimer.current = setTimeout(async () => {
        try {
          const res = await fetch("/api/cube/validate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title, markdown: text }),
          });
          if (res.ok) {
            const body = (await res.json()) as { issues: Issue[] };
            setIssues(body.issues);
          }
        } catch {
          // validation is advisory; network errors surface on save
        }
      }, 600);
    },
    [title],
  );

  useEffect(() => {
    validate(markdown);
    return () => {
      if (validateTimer.current) clearTimeout(validateTimer.current);
    };
  }, [markdown, validate]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setConflict(null);
    try {
      const res = await fetch(`/api/cube/page?title=${encodeURIComponent(title)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          markdown,
          comment,
          minor,
          ...(baseRevision !== null && { baseRevision }),
        }),
      });
      if (res.ok) {
        router.push(canonicalHref);
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        error?: { code: string; message: string; issues?: Issue[]; head?: number };
      } | null;
      const err = body?.error;
      if (err?.code === "validation_failed" && err.issues) {
        setIssues(err.issues);
        setError("Fix the errors below before saving.");
      } else if (err?.code === "conflict") {
        setConflict({ head: err.head ?? 0 });
      } else if (res.status === 401 || res.status === 403) {
        setError(err?.message ?? "You need to log in to edit.");
      } else {
        setError(err?.message ?? `Save failed (${res.status}).`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setSaving(false);
    }
  };

  const errors = issues.filter((i) => i.severity === "error");

  return (
    <div className="space-y-3">
      <div className="flex gap-1 text-sm">
        {(["source", "visual"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-t border border-b-0 px-3 py-1 ${
              mode === m
                ? "border-neutral-300 bg-white font-medium dark:border-neutral-700 dark:bg-neutral-950"
                : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            }`}
          >
            {m === "source" ? "Source" : "Visual (beta)"}
          </button>
        ))}
      </div>

      {mode === "source" ? (
        <textarea
          className="h-[32rem] w-full resize-y rounded border border-neutral-300 bg-white p-3 font-mono text-sm leading-relaxed dark:border-neutral-700 dark:bg-neutral-950"
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <div className="min-h-[32rem] rounded border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-950">
          <VisualEditor markdown={markdown} onChange={setMarkdown} specs={hpComponents} />
        </div>
      )}

      {issues.length > 0 && (
        <ul className="rounded border border-neutral-300 text-sm dark:border-neutral-700">
          {issues.map((i, n) => (
            <li key={n} className="flex gap-2 border-b border-neutral-200 px-3 py-1.5 last:border-b-0 dark:border-neutral-800">
              <span className={i.severity === "error" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}>
                {i.severity}
              </span>
              {i.line !== undefined && <span className="text-neutral-500">line {i.line}</span>}
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}

      {conflict && (
        <div className="rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950">
          Someone else saved revision r{conflict.head} while you were editing. Your changes could
          not be merged automatically.{" "}
          <a className="underline" href={`${canonicalHref}?source`} target="_blank" rel="noreferrer">
            Open the latest source
          </a>{" "}
          in a new tab, reconcile manually, then save again.
        </div>
      )}

      {error && (
        <div className="rounded border border-red-500 bg-red-50 px-3 py-2 text-sm dark:bg-red-950">
          {error}{" "}
          {(error.includes("log in") || error.includes("forbidden")) && (
            <a className="underline" href={`/login?next=${encodeURIComponent(`${canonicalHref}?edit`)}`}>
              Log in
            </a>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <input
          className="min-w-64 flex-1 rounded border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          placeholder="Describe your change (edit summary)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          <input type="checkbox" checked={minor} onChange={(e) => setMinor(e.target.checked)} />
          minor edit
        </label>
        <button
          className="rounded bg-neutral-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          onClick={save}
          disabled={saving || errors.length > 0}
        >
          {saving ? "Saving..." : isNew ? "Create page" : "Save changes"}
        </button>
        <a className="text-sm text-neutral-500 hover:underline" href={canonicalHref}>
          cancel
        </a>
      </div>
    </div>
  );
}
