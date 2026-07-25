"use client";

// Visual (TipTap) editor. Content flows through cube's canonical converters -
// markdown -> parseDocument -> mdastToDoc on mount, docToMarkdown on every
// (debounced) update: what this editor produces is defined entirely by cube's
// own parser and serializer, never TipTap's markdown machinery.
//
// TipTap is an implementation detail slated for replacement, so the public
// surface here is markdown in, markdown out. Emits cube-editor-* state markers
// only; the host supplies every style (see the styling note in README).

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  buildExtensions,
  builtinComponents,
  docToMarkdown,
  markdownToDoc,
  type PMDocJSON,
} from "../editor/index";
import { createRegistry, type ComponentSpec } from "../schema/index";

export type VisualEditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  /** Site component specs; cube built-ins are always included. */
  specs?: ComponentSpec[];
  placeholder?: string;
  /** Filled with a function that cancels the pending debounce, emits the
   *  current markdown through onChange and returns it (null when nothing is
   *  pending). The host calls it before saving so keystrokes younger than the
   *  debounce window are not dropped. */
  flushRef?: RefObject<(() => string | null) | null>;
};

export default function VisualEditor({
  markdown,
  onChange,
  specs,
  placeholder,
  flushRef,
}: VisualEditorProps) {
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
  // The newest document, parked by onUpdate. Held as ProseMirror JSON rather
  // than markdown because serializing is the expensive half; emit() converts.
  // Keeping it here (instead of reading the editor at flush time) is what makes
  // flushing safe on unmount, where TipTap has already destroyed the instance.
  const pendingDoc = useRef<PMDocJSON | null>(null);

  const emit = useCallback((): string | null => {
    if (debounce.current) {
      clearTimeout(debounce.current);
      debounce.current = null;
    }
    const doc = pendingDoc.current;
    if (doc === null) return null;
    pendingDoc.current = null;
    const md = docToMarkdown(doc, registry);
    onChangeRef.current(md);
    return md;
  }, [registry]);

  const emitRef = useRef(emit);
  emitRef.current = emit;

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () => emitRef.current();
    return () => {
      flushRef.current = null;
    };
  }, [flushRef]);

  // Flush rather than discard: unmount is how switching back to source mode
  // looks from here, and dropping the timer would lose the last edits.
  useEffect(() => () => void emitRef.current(), []);

  const editor = useEditor(
    {
      extensions,
      content: initial.doc ?? undefined,
      immediatelyRender: false,
      editorProps: { attributes: { class: "cube-editor-content" } },
      onUpdate({ editor: ed }) {
        pendingDoc.current = ed.getJSON() as PMDocJSON;
        if (debounce.current) clearTimeout(debounce.current);
        debounce.current = setTimeout(() => emitRef.current(), 300);
      },
    },
    [extensions, registry],
  );

  if (initial.doc === null) {
    return (
      <div className="cube-editor-parse-error" role="alert">
        The page source has parse errors, so it cannot be opened in the visual editor.
        Fix them in source mode first.
        <ul>
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
    <div className="cube-editor-visual">
      <div className="cube-editor-toolbar">
        {/* Semantic elements so the controls read correctly unstyled. */}
        <button type="button" title="Bold" onClick={() => editor?.chain().focus().toggleBold().run()}>
          <strong>B</strong>
        </button>
        <button type="button" title="Italic" onClick={() => editor?.chain().focus().toggleItalic().run()}>
          <em>I</em>
        </button>
        <button
          type="button"
          title="Heading"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </button>
        <button
          type="button"
          title="Bullet list"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          &bull; list
        </button>
        <select
          aria-label="Insert component"
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
