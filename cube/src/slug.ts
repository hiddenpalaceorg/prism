/**
 * MediaWiki-compatible title/slug codec.
 *
 * Cube page identity is (ns, slug) where slug uses MW "dbkey" semantics:
 * spaces become underscores and the first character is case-folded up, so
 * existing hiddenpalace.org/<Title> URLs resolve unchanged.
 */

export interface TitleRef {
  ns: string;
  /** dbkey form: "Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)" */
  slug: string;
  /** display form: slug with underscores as spaces */
  title: string;
  fragment?: string;
}

export interface SlugConfig {
  /**
   * Lowercased namespace prefix (spaces, not underscores) -> cube namespace id.
   * Includes aliases, e.g. { file: "file", image: "file", "user talk": "user_talk" }.
   */
  namespacePrefixes: Record<string, string>;
  /** Uppercase the first letter (MW $wgCapitalLinks). Default true. */
  capitalLinks?: boolean;
}

export const DEFAULT_NAMESPACE_PREFIXES: Record<string, string> = {
  talk: "talk",
  user: "user",
  "user talk": "user_talk",
  file: "file",
  image: "file",
  media: "file",
  "file talk": "talk",
  category: "category",
  "category talk": "talk",
  help: "help",
  "help talk": "talk",
  project: "project",
  "project talk": "talk",
  archive: "archive",
};

export const DEFAULT_SLUG_CONFIG: SlugConfig = {
  namespacePrefixes: DEFAULT_NAMESPACE_PREFIXES,
  capitalLinks: true,
};

const ILLEGAL = /[#<>[\]{}|\u0000-\u001F\u007F]/;

export type TitleError =
  | { error: "empty" }
  | { error: "illegal-char"; char: string }
  | { error: "relative" }
  | { error: "too-long" };

export function normalizeTitle(
  input: string,
  config: SlugConfig = DEFAULT_SLUG_CONFIG,
): TitleRef | TitleError {
  let text = input;
  let fragment: string | undefined;

  const hash = text.indexOf("#");
  if (hash >= 0) {
    fragment = text.slice(hash + 1).trim() || undefined;
    text = text.slice(0, hash);
  }

  // Underscores and whitespace runs collapse to single spaces; trim ends.
  text = text.replace(/[_\s]+/g, " ").trim();
  // A leading colon forces main namespace ("[[:Category:X]]" link form).
  text = text.replace(/^:+\s*/, "");
  if (text === "") return { error: "empty" };

  let ns = "main";
  const colon = text.indexOf(":");
  if (colon > 0) {
    const prefix = text.slice(0, colon).trim().toLowerCase();
    const mapped = config.namespacePrefixes[prefix];
    if (mapped !== undefined) {
      const rest = text.slice(colon + 1).trim();
      if (rest === "") return { error: "empty" };
      ns = mapped;
      text = rest;
    }
  }

  const illegal = ILLEGAL.exec(text);
  if (illegal) return { error: "illegal-char", char: illegal[0] };
  // Relative path segments are unresolvable as titles.
  if (
    text === "." ||
    text === ".." ||
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.includes("/./") ||
    text.includes("/../") ||
    text.endsWith("/.") ||
    text.endsWith("/..")
  ) {
    return { error: "relative" };
  }

  if (config.capitalLinks !== false) {
    const first = text.codePointAt(0)!;
    const firstChar = String.fromCodePoint(first);
    const upper = firstChar.toUpperCase();
    // Only fold single-char uppercasings (matches PHP ucfirst; avoids "ß" -> "SS").
    if (upper !== firstChar && [...upper].length === 1) {
      text = upper + text.slice(firstChar.length);
    }
  }

  if (Buffer.byteLength(text, "utf8") > 255) return { error: "too-long" };

  return { ns, slug: text.replace(/ /g, "_"), title: text, fragment };
}

export function isTitleError(t: TitleRef | TitleError): t is TitleError {
  return "error" in t;
}

export function titleFromSlug(slug: string): string {
  return slug.replace(/_/g, " ");
}

/** Full display title including namespace prefix, for rendering links. */
export function fullTitle(ref: { ns: string; title: string }, nsDisplay?: Record<string, string>): string {
  if (ref.ns === "main") return ref.title;
  const prefix = nsDisplay?.[ref.ns] ?? ref.ns.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return `${prefix}:${ref.title}`;
}
