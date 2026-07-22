/**
 * Two-step import save: history carries the ORIGINAL MediaWiki wikitext.
 *
 * Every imported MW revision lands verbatim as a wikitext_fallback revision
 * with its original author/timestamp/comment and mw_rev_id provenance; when a
 * markdown conversion is supplied, it saves as a second revision on top
 * ("convert to markdown"). Re-imports are idempotent by mw_rev_id.
 */

import type { Cube } from "../../index";
import { CubeValidationError, type Issue } from "../../issues";
import { isTitleError, normalizeTitle } from "../../slug";

export interface ImportRevisionInput {
  title: string;
  wikitext: string;
  mwRevId: number;
  mwAuthor: string;
  mwTimestamp: Date;
  mwComment: string;
  /** Converted markdown for this revision, or null to leave wikitext as head. */
  markdown: string | null;
}

export interface ImportRevisionResult {
  /** "imported" | "converted" (wikitext already present, conversion added) | "skipped" (mw rev already imported and converted). */
  outcome: "imported" | "converted" | "skipped";
  headRevId: number;
  /** Set when the converted markdown failed registry validation; the
   * wikitext revision stays head. */
  validationIssues?: Issue[];
}

export async function importRevision(cube: Cube, input: ImportRevisionInput): Promise<ImportRevisionResult> {
  const ref = normalizeTitle(input.title, cube.slug);
  if (isTitleError(ref)) throw new Error(`bad title: ${ref.error}`);
  const pool = cube.pool();

  // Idempotence: has this MW revision already been imported?
  const existing = await pool.query(
    `SELECT r.id, r.page_id, p.current_rev_id
       FROM cube_revision r JOIN cube_page p ON p.id = r.page_id
      WHERE r.mw_rev_id = $1`,
    [input.mwRevId],
  );

  let wikitextRevId: number;
  if (existing.rows[0] !== undefined) {
    wikitextRevId = Number(existing.rows[0].id);
    const head = Number(existing.rows[0].current_rev_id);
    // Converted already (head moved past the wikitext revision)?
    if (head !== wikitextRevId) return { outcome: "skipped", headRevId: head };
    if (input.markdown === null) return { outcome: "skipped", headRevId: head };
  } else {
    const page = await cube.api.getPage(ref);
    const saved = await cube.api.savePage({
      ns: ref.ns,
      slug: ref.slug,
      markdown: input.wikitext,
      baseRevId: page?.revId ?? null,
      author: { name: `wiki:${input.mwAuthor}` },
      comment: input.mwComment || "imported wikitext revision",
      wikitextFallback: true,
      timestamp: input.mwTimestamp,
      mwRevId: input.mwRevId,
    });
    wikitextRevId = saved.revId;
    if (input.markdown === null) return { outcome: "imported", headRevId: wikitextRevId };
  }

  try {
    const converted = await cube.api.savePage({
      ns: ref.ns,
      slug: ref.slug,
      markdown: input.markdown,
      baseRevId: wikitextRevId,
      author: { name: "wiki-import" },
      comment: "convert to markdown",
    });
    return {
      outcome: existing.rows[0] !== undefined ? "converted" : "imported",
      headRevId: converted.revId,
    };
  } catch (err) {
    if (err instanceof CubeValidationError) {
      return { outcome: "imported", headRevId: wikitextRevId, validationIssues: err.issues };
    }
    throw err;
  }
}
