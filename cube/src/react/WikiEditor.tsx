"use client";

// The page editor: source textarea + visual mode, live validation, and save.
//
// This is the client half of cube's save protocol - baseRevision optimistic
// concurrency, the conflict/validation_failed error codes, and the Issue shape
// the validator returns. It ships with cube so hosts get those semantics right
// by construction rather than reimplementing them per site.
//
// Framework-free by design: navigation after a save is an onSaved callback,
// route prefixes and host page links are props, and the visual editor is a
// React.lazy chunk. Emits cube-editor-* state markers only; the host styles it.

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { Issue } from "../issues";
import type { ComponentSpec } from "../schema/index";

// TipTap only loads when the visual mode is opened.
const VisualEditor = lazy(() => import("./VisualEditor"));

export type WikiEditorProps = {
  title: string;
  /** The page's own URL; used for the cancel link and post-save navigation. */
  canonicalHref: string;
  initialMarkdown: string;
  baseRevision: number | null;
  isNew: boolean;
  /** Site component specs for visual mode; cube built-ins are always included. */
  specs?: ComponentSpec[];
  /** Where cube's HTTP API is mounted. */
  apiBase?: string;
  /** Called after a successful save. Defaults to a full navigation. */
  onSaved?: (href: string) => void;
  /** Host's read-only source view, offered when a save conflicts. */
  sourceHref?: string;
  /** Host's login page, offered when the API rejects the save as anonymous. */
  loginHref?: string;
};

export default function WikiEditor({
  title,
  canonicalHref,
  initialMarkdown,
  baseRevision,
  isNew,
  specs,
  apiBase = "/api/cube",
  onSaved,
  sourceHref,
  loginHref,
}: WikiEditorProps) {
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
          const res = await fetch(`${apiBase}/validate`, {
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
    [title, apiBase],
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
      const res = await fetch(`${apiBase}/page?title=${encodeURIComponent(title)}`, {
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
        if (onSaved) onSaved(canonicalHref);
        else window.location.assign(canonicalHref);
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
    <div className="cube-editor">
      <div className="cube-editor-tabs">
        {(["source", "visual"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
          >
            {m === "source" ? "Source" : "Visual (beta)"}
          </button>
        ))}
      </div>

      {mode === "source" ? (
        <textarea
          className="cube-editor-source"
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <div className="cube-editor-surface">
          <Suspense fallback={<div className="cube-editor-loading">Loading visual editor...</div>}>
            <VisualEditor markdown={markdown} onChange={setMarkdown} specs={specs} />
          </Suspense>
        </div>
      )}

      {issues.length > 0 && (
        <ul className="cube-editor-issues">
          {issues.map((i, n) => (
            <li key={n}>
              <span className={`cube-editor-issue-${i.severity}`}>{i.severity}</span>
              {i.line !== undefined && <span className="cube-editor-issue-line">line {i.line}</span>}
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}

      {conflict && (
        <div className="cube-editor-conflict" role="alert">
          Someone else saved revision r{conflict.head} while you were editing. Your changes could
          not be merged automatically.{" "}
          {sourceHref !== undefined && (
            <>
              <a href={sourceHref} target="_blank" rel="noreferrer">
                Open the latest source
              </a>{" "}
              in a new tab, reconcile manually, then save again.
            </>
          )}
        </div>
      )}

      {error && (
        <div className="cube-editor-error" role="alert">
          {error}{" "}
          {loginHref !== undefined && (error.includes("log in") || error.includes("forbidden")) && (
            <a href={loginHref}>Log in</a>
          )}
        </div>
      )}

      <div className="cube-editor-actions">
        <input
          type="text"
          placeholder="Describe your change (edit summary)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <label>
          <input type="checkbox" checked={minor} onChange={(e) => setMinor(e.target.checked)} />
          minor edit
        </label>
        <button
          type="button"
          className="cube-editor-save"
          onClick={save}
          disabled={saving || errors.length > 0}
        >
          {saving ? "Saving..." : isNew ? "Create page" : "Save changes"}
        </button>
        <a className="cube-editor-cancel" href={canonicalHref}>
          cancel
        </a>
      </div>
    </div>
  );
}
