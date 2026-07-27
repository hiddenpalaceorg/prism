import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXTRACT_KINDS,
  isExtractKind,
  normalizeLang,
  validateExtractInput,
  validateIssueInput,
  validateMagazineInput,
} from "../src/lib/mag/kinds";

const REGION = { pdf_index: 3, x: 0.1, y: 0.2, w: 0.5, h: 0.3 };

function base(over: Record<string, unknown> = {}) {
  return {
    client_key: "p3-review-sonic",
    kind: "review",
    language: "en",
    text_original: "Sonic is fast.",
    regions: [REGION],
    ...over,
  };
}

test("taxonomy contains the survey-derived kinds", () => {
  for (const k of ["review", "preview", "tips", "chart", "high_scores", "ad", "ad_index", "comic", "poster"]) {
    assert.ok(isExtractKind(k), k);
  }
  assert.ok(!isExtractKind("advertisement"));
  assert.equal(new Set(EXTRACT_KINDS).size, EXTRACT_KINDS.length);
});

test("normalizeLang lowercases and validates bcp47-ish tags", () => {
  assert.equal(normalizeLang("EN"), "en");
  assert.equal(normalizeLang("pt-BR"), "pt-br");
  assert.equal(normalizeLang("ja"), "ja");
  assert.equal(normalizeLang("english"), null);
  assert.equal(normalizeLang(""), null);
  assert.equal(normalizeLang(42), null);
});

test("a valid extract passes and is normalized", () => {
  const v = validateExtractInput(
    base({
      section: "  Review Crew  ",
      title: "Sonic the Hedgehog",
      text_en: undefined,
      data: { scores: [{ reviewer: "Steve", value: 9, scale: 10 }] },
      games: [{ name: "Sonic the Hedgehog", system: "Sega Mega Drive", role: "subject", title_printed: "SONIC" }],
      people: [{ name: "Sushi-X", kind: "persona", role: "reviewer" }],
      systems: ["Sega Mega Drive"],
      tags: [{ kind: "company", name: "Sega" }],
    })
  );
  assert.ok(v.ok, v.ok ? "" : v.error);
  if (!v.ok) return;
  assert.equal(v.value.section, "Review Crew");
  assert.equal(v.value.games?.[0].system, "Sega Mega Drive");
  assert.equal(v.value.people?.[0].kind, "persona");
  assert.equal(v.value.is_fictional, false);
});

test("unknown kind, missing client_key, bad language are rejected", () => {
  assert.ok(!validateExtractInput(base({ kind: "advert" })).ok);
  assert.ok(!validateExtractInput(base({ client_key: "" })).ok);
  assert.ok(!validateExtractInput(base({ language: "English please" })).ok);
});

test("machine translation is implied when text_en is present", () => {
  const v = validateExtractInput(base({ language: "ja", text_original: "ソニック", text_en: "Sonic" }));
  assert.ok(v.ok);
  if (v.ok) assert.equal(v.value.translation, "machine");
});

test("regions clamp out-of-range coords and reject degenerate boxes", () => {
  const v = validateExtractInput(base({ regions: [{ pdf_index: 1, x: -0.05, y: 0.5, w: 1.2, h: 0.6 }] }));
  assert.ok(v.ok, v.ok ? "" : v.error);
  if (v.ok) {
    const r = v.value.regions[0];
    assert.equal(r.x, 0);
    assert.equal(r.w, 1);
    assert.equal(r.y, 0.5);
    assert.equal(r.h, 0.5);
  }
  assert.ok(!validateExtractInput(base({ regions: [] })).ok);
  assert.ok(!validateExtractInput(base({ regions: [{ pdf_index: 1, x: 0.999, y: 0, w: 0.9, h: 0.5 }] })).ok);
  assert.ok(!validateExtractInput(base({ regions: [{ pdf_index: 0, x: 0, y: 0, w: 1, h: 1 }] })).ok);
});

test("conventional data arrays must be arrays of objects", () => {
  assert.ok(!validateExtractInput(base({ data: { scores: { steve: 9 } } })).ok);
  assert.ok(!validateExtractInput(base({ data: { entries: ["1. Sonic"] } })).ok);
  assert.ok(validateExtractInput(base({ data: { entries: [{ rank: 1 }], anything_else: "free" } })).ok);
});

test("games and people links validate roles and kinds", () => {
  assert.ok(!validateExtractInput(base({ games: [{ name: "X", role: "hero" }] })).ok);
  assert.ok(!validateExtractInput(base({ people: [{ name: "X", kind: "robot" }] })).ok);
  assert.ok(!validateExtractInput(base({ games: [{ system: "SMS" }] })).ok);
  const v = validateExtractInput(base({ games: [{ name: "Columns" }] }));
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.value.games?.[0].role, "subject");
    assert.equal(v.value.games?.[0].system, "");
  }
});

test("issue input validates slug, date precision, and page labels", () => {
  const good = validateIssueInput({
    magazine: "egm",
    slug: "022",
    label: "Issue 22",
    cover_date: "1991-05-01",
    cover_date_precision: "month",
    page_labels: { "4": "4", "56": "supp:6" },
    supplements: [{ title: "Robocop 2 Strategy Guide", present: true }],
  });
  assert.ok(good.ok, good.ok ? "" : good.error);
  if (good.ok) {
    assert.equal(good.value.page_labels?.["56"], "supp:6");
    assert.equal(good.value.supplements?.[0].present, true);
  }
  assert.ok(!validateIssueInput({ magazine: "egm", slug: "Issue 22", label: "x" }).ok);
  assert.ok(!validateIssueInput({ magazine: "egm", slug: "022", label: "x", cover_date: "May 1991" }).ok);
  assert.ok(!validateIssueInput({ magazine: "egm", slug: "022", label: "x", page_labels: { abc: "1" } }).ok);
});

test("cover_date defaults to day precision when unstated", () => {
  const v = validateIssueInput({ magazine: "beep", slug: "1991-08", label: "1991-08", cover_date: "1991-08-01" });
  assert.ok(v.ok);
  if (v.ok) assert.equal(v.value.cover_date_precision, "day");
});

test("magazine input validates and passes the pages_public toggle through", () => {
  const v = validateMagazineInput({ title: "Beep! MegaDrive", language: "ja", country: "JP", pages_public: false });
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.value.pages_public, false);
    assert.equal(v.value.language, "ja");
  }
  const noToggle = validateMagazineInput({ title: "EGM" });
  assert.ok(noToggle.ok);
  if (noToggle.ok) assert.equal(noToggle.value.pages_public, undefined);
  assert.ok(!validateMagazineInput({ title: "" }).ok);
  assert.ok(!validateMagazineInput({ title: "X", slug: "Bad Slug" }).ok);
});
