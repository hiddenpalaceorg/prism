import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { gsAvailable, gsRenderable, gsToPng, patchStrippedIllustrator } from "../src/lib/gs";

// Rasterization tests need real Ghostscript and skip without it (set
// GHOSTSCRIPT_BIN when `gs` on PATH is something else, e.g. git-spice).

test("gsRenderable covers exactly the document mimes", () => {
  assert.equal(gsRenderable("application/pdf"), true);
  assert.equal(gsRenderable("application/postscript"), true);
  assert.equal(gsRenderable("image/tiff"), false);
  assert.equal(gsRenderable("text/plain"), false);
});

// 8x4pt EPS, solid red — small enough to assert pixels across the raster.
const EPS = Buffer.from(
  "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 8 4\n1 0 0 setrgbcolor 0 0 8 4 rectfill\nshowpage\n"
);

/** Minimal one-page-per-entry PDF, each page an 8x4pt solid-fill rect, with a
 *  correct xref table (Ghostscript tolerates a broken one; the fixture
 *  shouldn't lean on that). */
function tinyPdf(pageColors: string[]): Buffer {
  const objs: string[] = [];
  const kids = pageColors.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs.push(`1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`);
  objs.push(`2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pageColors.length} >> endobj\n`);
  pageColors.forEach((color, i) => {
    const content = `${color} rg 0 0 8 4 re f`;
    objs.push(
      `${3 + i * 2} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 8 4] /Contents ${4 + i * 2} 0 R >> endobj\n`
    );
    objs.push(`${4 + i * 2} 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj\n`);
  });
  let body = "%PDF-1.4\n";
  const offsets = objs.map((o) => {
    const at = body.length;
    body += o;
    return at;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** The raster's center pixel as [r,g,b,a]. */
function centerPixel(png: Buffer): number[] {
  const img = PNG.sync.read(png);
  const o = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
  return [...img.data.subarray(o, o + 4)];
}

test("gsToPng rasterizes an EPS at its BoundingBox", async (t) => {
  if (!(await gsAvailable())) return t.skip("ghostscript not installed");
  const png = PNG.sync.read(await gsToPng("application/postscript", EPS));
  // 8x4pt at 150dpi ≈ 17x8px — EPSCrop must have sized the page to the art.
  assert.ok(png.width >= 16 && png.width <= 18, `width ${png.width}`);
  assert.ok(png.height >= 8 && png.height <= 10, `height ${png.height}`);
  const o = ((png.height >> 1) * png.width + (png.width >> 1)) * 4;
  assert.deepEqual([...png.data.subarray(o, o + 4)], [255, 0, 0, 255]);
});

test("gsToPng renders only a PDF's first page", async (t) => {
  if (!(await gsAvailable())) return t.skip("ghostscript not installed");
  const pdf = tinyPdf(["1 0 0", "0 0 1"]); // page 1 red, page 2 blue
  assert.deepEqual(centerPixel(await gsToPng("application/pdf", pdf)), [255, 0, 0, 255]);
});

test("gsToPng throws on garbage input", async (t) => {
  if (!(await gsAvailable())) return t.skip("ghostscript not installed");
  await assert.rejects(gsToPng("application/postscript", Buffer.from("not postscript at all")));
});

// Prolog-stripped Illustrator EPS (Visual Park style): procsets referenced but
// not embedded, art in AI operators. Classic-Mac \r line endings on purpose —
// the corpus files carry them and the patcher must survive them. Body: a cyan
// 8x4 rect via a compound path (two subpaths, deferred paint), plus a
// gradient-block shape that must flatten to gray, not error.
const STRIPPED_AI = Buffer.from(
  [
    "%!PS-Adobe-3.0 ",
    "%%Creator: Adobe Illustrator(TM) 5.0",
    "%%BoundingBox: 0 0 8 4",
    "%%DocumentNeededResources: procset Adobe_level2_AI5 1.2 0",
    "%%+ procset Adobe_Illustrator_AI5 1.0 0",
    "%%EndComments",
    "%%BeginProlog",
    "%%IncludeResource: procset Adobe_level2_AI5 1.2 0",
    "%%EndProlog",
    "%%BeginSetup",
    "Adobe_level2_AI5 /initialize get exec",
    "Adobe_Illustrator_AI5 /initialize get exec",
    "%%EndSetup",
    "1 1 1 1 0 0 0 79 128 255 Lb",
    "(Layer 1) Ln",
    "0 A",
    "1 0 0 0 k",
    "*u",
    "0 0 m",
    "4 0 L",
    "4 4 L",
    "0 4 L",
    "f",
    "4 0 m",
    "8 0 L",
    "8 4 L",
    "4 4 L",
    "f",
    "*U",
    "Bb",
    "2 (Chrome) 0 0 0 0 1 0 0 1 0 0 Bg",
    "0 0 m",
    "1 1 L",
    "f",
    "0 BB",
    "LB",
    "%%PageTrailer",
    "gsave annotatepage grestore showpage",
    "%%Trailer",
    "Adobe_Illustrator_AI5 /terminate get exec",
    "Adobe_level2_AI5 /terminate get exec",
    "%%EOF",
  ].join("\r"),
  "latin1"
);

test("patchStrippedIllustrator targets only prolog-stripped files", () => {
  const patched = patchStrippedIllustrator(STRIPPED_AI);
  assert.ok(patched, "stripped AI file should be patched");
  const text = patched.toString("latin1");
  assert.ok(text.includes("/AICompat"), "compat prolog spliced in");
  assert.ok(!/Adobe_\S+ \/initialize get exec/.test(text), "initialize calls removed");
  assert.ok(!/^%%BeginSetup/m.test(text), "setup section removed");
  // A self-contained EPS is left alone.
  assert.equal(patchStrippedIllustrator(EPS), null);
});

test("gsToPng renders prolog-stripped Illustrator art", async (t) => {
  if (!(await gsAvailable())) return t.skip("ghostscript not installed");
  const png = PNG.sync.read(await gsToPng("application/postscript", STRIPPED_AI));
  // The synthesized BoundingBox crop must hold (8x4pt at 150dpi ≈ 17x9px).
  assert.ok(png.width >= 16 && png.width <= 18, `width ${png.width}`);
  assert.ok(png.height >= 8 && png.height <= 10, `height ${png.height}`);
  // Both compound subpaths must have painted cyan (1 0 0 0 cmyk) at 1/4 and
  // 3/4 width. Exact RGB depends on Ghostscript's CMYK conversion — assert
  // the hue, not the profile.
  for (const fx of [0.25, 0.75]) {
    const o = ((png.height >> 1) * png.width + Math.floor(png.width * fx)) * 4;
    const [r, g, b] = png.data.subarray(o, o + 3);
    assert.ok(r < 100 && g > 130 && b > 200, `cyan-ish at ${fx}, got ${r},${g},${b}`);
  }
});
