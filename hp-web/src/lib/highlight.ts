// Syntax highlighting for "source" assets (client-side). highlight.js core
// with only the grammars the adapter's source kind can emit (see
// ps2exe-adapter/prism_adapter/viewable.py) — the full hljs build would drag
// ~190 grammars into the bundle. Colors live in globals.css (.hljs-* rules).

import hljs from "highlight.js/lib/core";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import x86asm from "highlight.js/lib/languages/x86asm";
import makefile from "highlight.js/lib/languages/makefile";
import dos from "highlight.js/lib/languages/dos";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import perl from "highlight.js/lib/languages/perl";
import basic from "highlight.js/lib/languages/basic";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import lua from "highlight.js/lib/languages/lua";
import delphi from "highlight.js/lib/languages/delphi";

hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("x86asm", x86asm);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("dos", dos);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("perl", perl);
hljs.registerLanguage("basic", basic);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("css", css);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("delphi", delphi);

// Extension → grammar. C-like game scripting sources (.ssl) and .rc resource
// scripts read closest as C; .def/.lnk/.prj linker and project files have no
// grammar and render plain.
const EXT_LANG: Record<string, string> = {
  c: "c",
  h: "c",
  inc: "c",
  rc: "c",
  ssl: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  s: "x86asm",
  asm: "x86asm",
  mak: "makefile",
  mk: "makefile",
  bat: "dos",
  cmd: "dos",
  sh: "bash",
  py: "python",
  pl: "perl",
  bas: "basic",
  js: "javascript",
  mjs: "javascript",
  css: "css",
  lua: "lua",
  pas: "delphi",
};

// Extensionless filenames that map to a grammar (mirrors the adapter).
const NAME_LANG: Record<string, string> = { makefile: "makefile", gnumakefile: "makefile" };

// Above this, skip highlighting — hljs on megabyte inputs stalls the tab.
const HIGHLIGHT_CAP = 512_000;

export function sourceLanguage(path: string): string | null {
  const name = (path.split("/").pop() || path).toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return (ext ? EXT_LANG[ext] : NAME_LANG[name]) ?? null;
}

/** Highlighted (and HTML-escaped, hljs does both) markup for a source file,
 *  or null when there's no grammar / the file is too big — render plain then. */
export function highlightHtml(text: string, path: string): string | null {
  const lang = sourceLanguage(path);
  if (!lang || text.length > HIGHLIGHT_CAP) return null;
  try {
    return hljs.highlight(text, { language: lang }).value;
  } catch {
    return null;
  }
}
