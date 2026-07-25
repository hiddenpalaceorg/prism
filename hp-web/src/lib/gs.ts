// Ghostscript-backed rasterization: PostScript/EPS (and PDF first pages) to
// PNG. Unlike the raster formats imgpng.ts decodes in pure JS, PostScript is
// a programming language — rendering it takes the real interpreter. Ghostscript
// is a soft dependency: feature-detected at runtime, and every caller degrades
// (download-only viewer, generated OG card) when it's missing.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const GS_BIN = process.env.GHOSTSCRIPT_BIN || "gs";

// Kill a render that runs away — a PostScript file is a program and can loop.
const GS_TIMEOUT_MS = 15_000;

// Refuse to hand back absurd rasters (a hostile BoundingBox can demand acres).
const MAX_PNG_BYTES = 32_000_000;

// pdfwrite output cap — matches the 64 MiB asset cap, so any stored
// PostScript asset has room to convert.
const MAX_PDF_BYTES = 64 * 1024 * 1024;

// Target resolution, and the raster-size cap a huge BoundingBox degrades
// against (the render drops below 150dpi rather than exploding).
const GS_DPI = 150;
const MAX_PIXELS = 16_000_000;

/** Mimes gsToPng can rasterize. */
export function gsRenderable(mime: string): boolean {
  return mime === "application/pdf" || mime === "application/postscript";
}

/** Mimes gsToPdf converts (PDF itself is already a PDF — served raw). */
export function pdfConvertible(mime: string): boolean {
  return mime === "application/postscript";
}

// Feature detection, memoized for the process lifetime. A `gs` on PATH is not
// proof: on macOS dev machines `gs` is commonly git-spice, so the banner must
// actually say Ghostscript.
let available: Promise<boolean> | null = null;

export function gsAvailable(): Promise<boolean> {
  available ??= execFileP(GS_BIN, ["-h"], { timeout: 5_000 })
    .then(({ stdout }) => /ghostscript/i.test(stdout))
    .catch(() => false);
  return available;
}

// --- Illustrator EPS with stripped procsets ---------------------------------
//
// Illustrator normally embeds its procsets (Adobe_level2_AI5 etc.) in every
// EPS, and those render in Ghostscript as-is. Some discs strip them to save
// space (Visual Park ships 335 clipart files whose prologs are gone because
// the game carries its own AI parser), leaving `%%IncludeResource` references
// nothing can resolve. For those files we drop the dead setup section and
// prepend a minimal implementation of the AI3/AI5 operators the art actually
// uses — paths, fills/strokes, CMYK/gray/spot color, compound paths, layers,
// guides. Gradient-painted objects (Bb..BB) are dropped rather than mimicked;
// everything else renders faithfully.
//
// The operator set below was chosen from a census of the corpus files; an
// unknown operator in some future file just errors the render, and callers
// fall back to the download card.
const AI_COMPAT_PROLOG = `%%BeginProlog
/AICompat 80 dict def
AICompat begin
/_fk [0 0 0 1] def /_sk [0 0 0 1] def
/_fg null def /_sg null def
/k { _fk astore pop /_fg null store } bind def
/K { _sk astore pop /_sg null store } bind def
/g { /_fg exch store } bind def
/G { /_sg exch store } bind def
/x { pop pop _fk astore pop /_fg null store } bind def
/X { pop pop _sk astore pop /_sg null store } bind def
% Inside a gradient block (Bb..BB) fills flatten to light gray — the gradient
% machinery isn't emulated and its stop colors live in the stripped setup —
% while strokes keep their real (flat) color.
/_setf { _gb { 0.75 setgray }
         { _fg null eq { _fk aload pop setcmykcolor } { _fg setgray } ifelse } ifelse } bind def
/_sets { _sg null eq { _sk aload pop setcmykcolor } { _sg setgray } ifelse } bind def
/m { moveto } bind def
/l { lineto } bind def /L { lineto } bind def
/c { curveto } bind def /C { curveto } bind def
/v { currentpoint 6 2 roll curveto } bind def /V /v load def
/y { 2 copy curveto } bind def /Y /y load def
/h { closepath } bind def /H { closepath } bind def
% Compound paths (*u..*U): interior paint ops are deferred so subpaths
% accumulate and holes keep their winding; the close of the group paints once.
/_cd 0 def /_cp null def /_gb false def
/_paint { _cd 0 gt { /_cp exch store } { exec } ifelse } bind def
/f { { closepath _setf fill } _paint } bind def
/F { { _setf fill } _paint } bind def
/s { { closepath _sets stroke } _paint } bind def
/S { { _sets stroke } _paint } bind def
/b { { closepath gsave _setf fill grestore _sets stroke } _paint } bind def
/B { { gsave _setf fill grestore _sets stroke } _paint } bind def
/n { { newpath } _paint } bind def /N /n load def
% "/_cp load", never bare "_cp": executing the name would run the stored
% paint procedure instead of pushing it.
/*u { /_cd _cd 1 add store } bind def
/*U { /_cd _cd 1 sub store
      _cd 0 eq { /_cp load null ne { /_cp load exec /_cp null store } if } if } bind def
/* { pop newpath } bind def % guide: discard the path
/w { setlinewidth } bind def
/j { setlinejoin } bind def /J { setlinecap } bind def
/M { setmiterlimit } bind def /d { setdash } bind def
/D { pop } bind def /A { pop } bind def
/O { pop } bind def /R { pop } bind def
/Ar { pop } bind def /Ap { pop } bind def
/u {} def /U {} def
/q { gsave } bind def /Q { grestore } bind def /W { clip } bind def
/Lb { clear } bind def /Ln { pop } bind def /LB {} def
/Bb { /_gb true store } bind def
/BB { clear newpath /_gb false store } bind def
/Bg { clear } bind def /Bm { clear } bind def
/Bc { clear } bind def /Bh { clear } bind def
/annotatepage {} def
%%EndProlog
`;

/** For an Illustrator EPS whose Adobe procsets are referenced but not
 *  embedded: the file with the compat prolog spliced in, else null. */
export function patchStrippedIllustrator(bytes: Buffer): Buffer | null {
  // Only the head matters for detection; procset references sit in the DSC
  // comments. Skip files that embed their resources — they render natively.
  const head = bytes.subarray(0, 8192).toString("latin1");
  if (!/^%%(?:DocumentNeededResources:|IncludeResource:)\s*procset\s+Adobe_/m.test(head)) return null;
  if (/^%%BeginResource:\s*procset\s+Adobe_/m.test(head)) return null;

  // Classic-Mac \r-only line endings survive in these files; JS multiline
  // anchors treat \r as a line break, so ^/$ work either way.
  const text = bytes.toString("latin1");
  const patched = text
    // The setup section only initializes the missing procsets and defines
    // patterns/gradients/palettes our stubs never reference.
    .replace(/^%%BeginSetup[\s\S]*?^%%EndSetup[^\r\n]*/m, "")
    .replace(/^Adobe_\S+ \/(?:initialize|terminate) get exec[^\r\n]*$/gm, "")
    .replace(/^%%EndComments[^\r\n]*/m, (m) => m + "\n" + AI_COMPAT_PROLOG);
  return Buffer.from(patched, "latin1");
}

/** The EPS %%BoundingBox (pt), from the DSC header — or the trailer when the
 *  header defers with "(atend)". Null when absent or degenerate. */
export function epsBoundingBox(
  bytes: Buffer
): { x1: number; y1: number; x2: number; y2: number } | null {
  const re = /^%%BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/gm;
  const head = bytes.subarray(0, 8192).toString("latin1");
  let m = re.exec(head);
  if (!m && /^%%BoundingBox:\s*\(atend\)/m.test(head)) {
    const tail = bytes.subarray(-4096).toString("latin1");
    for (let t; (t = re.exec(tail)); ) m = t; // last one wins per DSC
  }
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
  return x2 > x1 && y2 > y1 ? { x1, y1, x2, y2 } : null;
}

/**
 * Rasterize a PDF or PostScript asset to a PNG of its first page. Throws when
 * Ghostscript is missing, times out, errors on the input, or the raster is
 * outlandish. Input and output go through a private temp dir: PDF needs a
 * seekable file (stdin won't do), and a `%d` output template keeps a
 * multi-page PostScript job from concatenating PNGs into one stream.
 */
export async function gsToPng(mime: string, bytes: Buffer): Promise<Buffer> {
  if (!(await gsAvailable())) throw new Error("ghostscript not available");

  // EPS art is cropped to its declared BoundingBox by sizing the device to it
  // and shifting the origin. Not -dEPSCrop: that needs an `EPSF-3.0` header
  // marker, which real dumps (Illustrator among them) routinely omit, leaving
  // small art adrift on a letter-size page.
  let crop: string[] = [];
  let translate: string[] = [];
  if (mime === "application/postscript") {
    bytes = patchStrippedIllustrator(bytes) ?? bytes;
    const bb = epsBoundingBox(bytes);
    if (bb) {
      const wPt = bb.x2 - bb.x1;
      const hPt = bb.y2 - bb.y1;
      let dpi = GS_DPI;
      if ((wPt / 72) * (hPt / 72) * dpi * dpi > MAX_PIXELS) {
        dpi = Math.floor(Math.sqrt(MAX_PIXELS / ((wPt / 72) * (hPt / 72))));
        if (dpi < 1) throw new Error(`EPS BoundingBox out of range: ${wPt}x${hPt}pt`);
      }
      const w = Math.ceil((wPt / 72) * dpi);
      const h = Math.ceil((hPt / 72) * dpi);
      crop = [`-r${dpi}`, `-g${w}x${h}`, "-dFIXEDMEDIA"];
      translate = ["-c", `${-bb.x1} ${-bb.y1} translate`, "-f"];
    }
  }

  const dir = await mkdtemp(join(tmpdir(), `gs-${randomBytes(4).toString("hex")}-`));
  try {
    const input = join(dir, "input");
    await writeFile(input, bytes);
    const args = [
      // -dSAFER is the default since 9.50 but stays explicit; -P- keeps the
      // interpreter from resolving libraries via the working directory; the
      // stdout redirect stops PostScript `print` chatter reaching our pipes.
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-q",
      "-P-",
      "-sstdout=%stderr",
      // White-background RGB: documents read right on it, and satori (the OG
      // renderer) has no use for alpha. Alpha bits smooth line art.
      "-sDEVICE=png16m",
      `-r${GS_DPI}`,
      "-dTextAlphaBits=4",
      "-dGraphicsAlphaBits=4",
      ...(mime === "application/pdf" ? ["-dFirstPage=1", "-dLastPage=1"] : []),
      ...crop,
      "-sOutputFile=" + join(dir, "out-%d.png"),
      ...translate,
      input,
    ];
    await execFileP(GS_BIN, args, { timeout: GS_TIMEOUT_MS, maxBuffer: 4_000_000 });
    const png = await readFile(join(dir, "out-1.png"));
    if (png.length === 0 || png.length > MAX_PNG_BYTES) {
      throw new Error(`gs raster out of range: ${png.length} bytes`);
    }
    return png;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Convert a PostScript/EPS asset to PDF with the vectors intact — the web
 * viewer renders the result client-side (pdf.js), so zoom stays sharp at any
 * scale. Same crop treatment as gsToPng: the page is sized to the declared
 * BoundingBox so EPS art fills its page instead of drifting on letter paper.
 * Multi-page PostScript converts to a multi-page PDF. Throws when Ghostscript
 * is missing, times out, errors on the input, or the output is outlandish.
 */
export async function gsToPdf(bytes: Buffer): Promise<Buffer> {
  if (!(await gsAvailable())) throw new Error("ghostscript not available");

  bytes = patchStrippedIllustrator(bytes) ?? bytes;
  let media: string[] = [];
  let translate: string[] = [];
  const bb = epsBoundingBox(bytes);
  if (bb) {
    media = [
      `-dDEVICEWIDTHPOINTS=${bb.x2 - bb.x1}`,
      `-dDEVICEHEIGHTPOINTS=${bb.y2 - bb.y1}`,
      "-dFIXEDMEDIA",
    ];
    translate = ["-c", `${-bb.x1} ${-bb.y1} translate`, "-f"];
  }

  const dir = await mkdtemp(join(tmpdir(), `gs-${randomBytes(4).toString("hex")}-`));
  try {
    const input = join(dir, "input");
    await writeFile(input, bytes);
    const args = [
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-q",
      "-P-",
      "-sstdout=%stderr",
      "-sDEVICE=pdfwrite",
      ...media,
      "-sOutputFile=" + join(dir, "out.pdf"),
      ...translate,
      input,
    ];
    await execFileP(GS_BIN, args, { timeout: GS_TIMEOUT_MS, maxBuffer: 4_000_000 });
    const pdf = await readFile(join(dir, "out.pdf"));
    if (pdf.length === 0 || pdf.length > MAX_PDF_BYTES) {
      throw new Error(`gs pdf out of range: ${pdf.length} bytes`);
    }
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
