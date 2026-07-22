"use client";

// Visual (TipTap) wiki editor built on cube/editor. Generic: takes site
// component specs as a prop and builds the registry locally (cube built-ins
// always included). Content flows through cube's canonical converters -
// markdown -> parseDocument -> mdastToDoc on mount, docToMarkdown on every
// (debounced) update: so what this editor saves is defined entirely by
// cube's own parser and serializer. The orchestrator wires it into the
// WikiEditor save plumbing.

import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  buildExtensions,
  builtinComponents,
  docToMarkdown,
  markdownToDoc,
  type PMDocJSON,
} from "cube/editor";
import { createRegistry, type ComponentSpec } from "cube/schema";

interface Props {
  markdown: string;
  onChange: (markdown: string) => void;
  /** Site component specs; cube built-ins are always included. */
  specs?: ComponentSpec[];
  placeholder?: string;
}

const BTN =
  "rounded border border-neutral-300 px-2 py-1 text-sm leading-none hover:bg-neutral-100 " +
  "dark:border-neutral-700 dark:hover:bg-neutral-800";

export default function VisualEditor({ markdown, onChange, specs, placeholder }: Props) {
  const registry = useMemo(
    () => createRegistry([...builtinComponents, ...(specs ?? [])]),
    [specs],
  );
  const extensions = useMemo(
    () => buildExtensions(registry, placeholder === undefined ? {} : { placeholder }),
    [registry, placeholder],
  );

  // Initial content only; after mount the editor owns the document state.
  const initialMarkdown = useRef(markdown);
  const initial = useMemo(
    () => markdownToDoc(initialMarkdown.current, registry),
    [registry],
  );

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  const editor = useEditor(
    {
      extensions,
      content: initial.doc ?? undefined,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class:
            "cube-ed-content min-h-[32rem] w-full rounded border border-neutral-300 bg-white " +
            "p-3 text-sm leading-relaxed focus:outline-none dark:border-neutral-700 dark:bg-neutral-950",
        },
      },
      onUpdate({ editor: ed }) {
        if (debounce.current) clearTimeout(debounce.current);
        debounce.current = setTimeout(() => {
          onChangeRef.current(docToMarkdown(ed.getJSON() as PMDocJSON, registry));
        }, 300);
      },
    },
    [extensions, registry],
  );

  if (initial.doc === null) {
    return (
      <div className="rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950">
        The page source has parse errors, so it cannot be opened in the visual editor.
        Fix them in source mode first.
        <ul className="mt-1 list-disc pl-5">
          {initial.issues.map((issue, n) => (
            <li key={n}>
              {issue.line !== undefined ? `line ${issue.line}: ` : ""}
              {issue.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const insertComponent = (name: string) => {
    const spec = registry.get(name);
    if (!spec || !editor) return;
    const attrs: Record<string, unknown> = {};
    for (const [key, a] of Object.entries(spec.attrs)) {
      attrs[key] = a.default !== undefined ? a.default : null;
    }
    const node: Record<string, unknown> = { type: `cube_${name}`, attrs };
    if (spec.children === "markdown") node.content = [{ type: "paragraph" }];
    editor.chain().focus().insertContent(node).run();
  };

  return (
    <div className="space-y-2">
      <style>{`
        .cube-ed-content p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          height: 0;
          color: #9ca3af;
          pointer-events: none;
        }
        .cube-ed-content table { border-collapse: collapse; }
        .cube-ed-content th, .cube-ed-content td {
          border: 1px solid #d4d4d8;
          padding: 2px 8px;
          min-width: 3rem;
        }
        .cube-ed-component {
          border: 1px solid #94a3b8;
          border-radius: 4px;
          background: rgba(148, 163, 184, 0.08);
          margin: 0.5rem 0;
          padding: 2px 6px;
        }
        .cube-ed-component-head {
          font-family: ui-monospace, monospace;
          font-size: 12px;
          color: #64748b;
          user-select: none;
        }
        .cube-ed-component.cube-ed-inline,
        .cube-ed-unknown.cube-ed-inline {
          display: inline;
          margin: 0 1px;
          padding: 0 4px;
          font-family: ui-monospace, monospace;
          font-size: 12px;
          white-space: nowrap;
        }
        .cube-ed-component:not(.cube-ed-inline):not(:has(.cube-ed-component-body)) {
          font-family: ui-monospace, monospace;
          font-size: 12px;
          color: #64748b;
        }
        .cube-ed-unknown {
          border: 1px dashed #f59e0b;
          border-radius: 4px;
          background: rgba(245, 158, 11, 0.08);
          font-family: ui-monospace, monospace;
          font-size: 12px;
          padding: 2px 6px;
          white-space: pre-wrap;
        }
        .cube-ed-raw {
          border: 1px dashed #94a3b8;
          border-radius: 4px;
          font-family: ui-monospace, monospace;
          font-size: 12px;
          padding: 2px 6px;
          white-space: pre-wrap;
          color: #64748b;
        }
        .cube-ed-wikilink {
          color: #2563eb;
          background: rgba(37, 99, 235, 0.08);
          border-radius: 3px;
          padding: 0 2px;
        }
      `}</style>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={`${BTN} font-bold`}
          title="Bold"
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          B
        </button>
        <button
          type="button"
          className={`${BTN} italic`}
          title="Italic"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          I
        </button>
        <button
          type="button"
          className={BTN}
          title="Heading"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </button>
        <button
          type="button"
          className={BTN}
          title="Bullet list"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          &bull; list
        </button>
        <select
          className={`${BTN} bg-transparent`}
          value=""
          onChange={(e) => {
            if (e.target.value !== "") insertComponent(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            Insert component
          </option>
          {registry
            .all()
            .filter((spec) => spec.placement === "block")
            .map((spec) => (
              <option key={spec.name} value={spec.name}>
                {spec.name}
              </option>
            ))}
        </select>
      </div>

      <EditorContent editor={editor} />
    </div>
  );
}
