"use client";

// Body of a source asset's <pre>: syntax-highlighted when a grammar matches
// the filename, plain text otherwise. hljs escapes the input, so injecting
// its output is safe.

import { useMemo } from "react";
import { highlightHtml } from "@/lib/highlight";

export default function SourceCode({ path, text }: { path: string; text: string }) {
  const html = useMemo(() => highlightHtml(text, path), [path, text]);
  if (html == null) return <>{text}</>;
  return <code dangerouslySetInnerHTML={{ __html: html }} />;
}
