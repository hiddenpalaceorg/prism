// Canonical build URLs: /builds/<short sha256>-<name slug>.
//
// The short sha is the first SHORT_SHA_LEN hex chars of the image sha256 —
// 40 bits, so even a 100k-build corpus has a <0.5% chance of *any* two builds
// sharing a prefix, and resolution falls back to the slug when one ever does
// (see resolveBuild). Any 8-64 char hex prefix works as a URL, slug or not,
// full sha included; non-canonical forms redirect to the canonical one.
//
// Client-safe: no server-only imports (client components link to builds too).

export const SHORT_SHA_LEN = 10;
const SLUG_MAX = 80;

/** Lowercase-ascii slug of a build name ("" when nothing survives). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics left by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** The /games/<slug> segment: name slug, "--" + system slug when the system
 *  is known. Slugify collapses dash runs, so "--" can never occur inside a
 *  part — the delimiter is unambiguous. Uniqueness is enforced at insert
 *  (colliding spellings get a "-<id>" suffix appended). */
export function gameSlug(name: string, system = ""): string {
  const n = slugify(name);
  const s = slugify(system);
  return s ? `${n}--${s}` : n;
}

/** The canonical /builds/ path segment: "<short sha>-<slug>" (short sha alone for empty slugs). */
export function canonicalBuildId(sha256: string, name: string): string {
  const short = sha256.slice(0, SHORT_SHA_LEN);
  const slug = slugify(name);
  return slug ? `${short}-${slug}` : short;
}

/** Canonical page URL of a build. */
export function buildHref(sha256: string, name: string): string {
  return `/builds/${canonicalBuildId(sha256, name)}`;
}

/** Asset paths are stored with a leading "/"; URL segments never carry it.
 *  Normalize before comparing a URL-derived path against a stored one. */
export function normalizeAssetPath(p: string): string {
  return p.replace(/^\/+/, "");
}

/** Deep link to one asset of a build, path segments individually encoded. */
export function assetHref(buildHref: string, assetPath: string): string {
  const segments = normalizeAssetPath(assetPath).split("/").map(encodeURIComponent);
  return `${buildHref}/assets/${segments.join("/")}`;
}

export interface ParsedBuildParam {
  /** Lowercased hex prefix of the sha256 (8-64 chars). */
  hex: string;
  /** The trailing slug, if the URL carried one. */
  slug: string | null;
}

/** Split a /builds/[buildId] param into hex prefix + optional slug; null if malformed. */
export function parseBuildParam(param: string): ParsedBuildParam | null {
  const m = /^([0-9a-fA-F]{8,64})(?:-(.+))?$/.exec(param);
  if (!m) return null;
  return { hex: m[1].toLowerCase(), slug: m[2] ?? null };
}

/** decodeURIComponent that passes through segments that were never encoded
 *  (a literal "%" in a filename must not throw). */
export function safeDecodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}
