import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const runtime = "nodejs";

// GET /api/pdfjs/<dir>/<file> — pdf.js support files served out of the
// installed package: the worker bundle, CJK character maps, the 14 standard
// fonts, and the image-decoder wasm. The client viewer (PdfViewer.tsx) points
// pdf.js here, which keeps the worker same-origin (no bundler asset-URL
// gymnastics) and the heavyweight data files out of the JS chunks.

const ALLOWED_DIRS = new Set(["build", "cmaps", "standard_fonts", "wasm", "iccs"]);

const CONTENT_TYPES: Record<string, string> = {
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
};

// node_modules walk-up from the server's working directory, not
// require.resolve: bundlers rewrite that to virtual module ids whose paths
// the filesystem has never heard of. Handles the workspace layout (deps
// hoisted to the repo root) and a plain local install alike.
let pkgDir: string | null | undefined;
function pdfjsDir(): string | null {
  if (pkgDir === undefined) {
    pkgDir = null;
    for (let dir = process.cwd(); ; ) {
      const candidate = join(dir, "node_modules", "pdfjs-dist");
      if (existsSync(join(candidate, "package.json"))) {
        pkgDir = candidate;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return pkgDir;
}

export async function GET(_request: Request, ctx: { params: Promise<{ file: string[] }> }) {
  const { file } = await ctx.params;
  // <dir>/<name> only — no deeper nesting exists in the package, and every
  // segment is checked against a conservative charset (no dot-dot, no slash).
  if (
    file.length !== 2 ||
    !ALLOWED_DIRS.has(file[0]) ||
    !/^[\w.-]+$/.test(file[1]) ||
    file[1].includes("..")
  ) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const dir = pdfjsDir();
  if (!dir) return Response.json({ error: "pdfjs not installed" }, { status: 404 });

  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, file[0], file[1]));
  } catch {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const ext = file[1].slice(file[1].lastIndexOf("."));
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      // Not immutable: the files change when the pdfjs-dist version does.
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
