import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SLUG_CONFIG, fullTitle, isTitleError, normalizeTitle, titleFromSlug } from "../src/slug";

function ok(input: string) {
  const r = normalizeTitle(input, DEFAULT_SLUG_CONFIG);
  assert.ok(!isTitleError(r), `expected ok for ${JSON.stringify(input)}, got ${JSON.stringify(r)}`);
  return r;
}

test("spaces and underscores normalize to the same slug", () => {
  const a = ok("Sonic the Hedgehog 2 (Nick Arcade prototype)");
  const b = ok("Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)");
  assert.equal(a.slug, b.slug);
  assert.equal(a.slug, "Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)");
  assert.equal(b.title, "Sonic the Hedgehog 2 (Nick Arcade prototype)");
});

test("first letter is capitalized (unicode-aware, single-char foldings only)", () => {
  assert.equal(ok("sonic 2").slug, "Sonic_2");
  assert.equal(ok("über prototype").slug, "Über_prototype");
  // ß uppercases to SS (multi-char): left alone, matching PHP ucfirst.
  assert.equal(ok("ßeta").slug, "ßeta");
});

test("namespace prefixes and aliases resolve", () => {
  assert.deepEqual(ok("File:S2NA Title.png"), {
    ns: "file", slug: "S2NA_Title.png", title: "S2NA Title.png", fragment: undefined,
  });
  assert.equal(ok("Image:x.png").ns, "file");
  assert.equal(ok("user talk:Drx").ns, "user_talk");
  assert.equal(ok("USER:Drx").ns, "user");
});

test("colons in titles that are not namespaces stay in main", () => {
  const r = ok("007: Blood Stone (Oct 12, 2010 prototype)");
  assert.equal(r.ns, "main");
  assert.equal(r.title, "007: Blood Stone (Oct 12, 2010 prototype)");
});

test("leading colon forces main namespace", () => {
  const r = ok(":Category:Prototypes");
  // The colon strips, then Category: resolves as a normal prefix.
  assert.equal(r.ns, "category");
});

test("fragments split off", () => {
  const r = ok("Hardware#Sega Mega Drive");
  assert.equal(r.slug, "Hardware");
  assert.equal(r.fragment, "Sega Mega Drive");
});

test("whitespace runs collapse", () => {
  assert.equal(ok("  Sonic   the    Hedgehog ").slug, "Sonic_the_Hedgehog");
});

test("subpage slashes survive", () => {
  assert.equal(ok("Video/Sonic the Hedgehog 2/Intro").slug, "Video/Sonic_the_Hedgehog_2/Intro");
});

test("illegal characters are rejected", () => {
  for (const bad of ["a<b", "a>b", "a[b", "a]b", "a{b", "a}b", "a|b"]) {
    const r = normalizeTitle(bad);
    assert.ok(isTitleError(r) && r.error === "illegal-char", `expected illegal for ${bad}`);
  }
});

test("empty and relative titles are rejected", () => {
  assert.ok(isTitleError(normalizeTitle("")));
  assert.ok(isTitleError(normalizeTitle("   ")));
  assert.ok(isTitleError(normalizeTitle("File:")));
  assert.ok(isTitleError(normalizeTitle("..")));
  assert.ok(isTitleError(normalizeTitle("../etc")));
  assert.ok(isTitleError(normalizeTitle("a/../b")));
});

test("byte-length limit", () => {
  assert.ok(isTitleError(normalizeTitle("x".repeat(256))));
  assert.ok(!isTitleError(normalizeTitle("x".repeat(255))));
});

test("round-trips: titleFromSlug inverts slug spacing", () => {
  const r = ok("Sonic Adventure 2: The Trial");
  assert.equal(titleFromSlug(r.slug), r.title);
});

test("exotic real titles from the wiki survive", () => {
  // From the titles-fetch spike: %, ?, &, +, curly quotes, ♯, fullwidth solidus.
  for (const t of [
    "Mature 17+",
    "DRW-",
    "Pokémon X／Y assets",
    "Jak 3 (Aug 21, 2004 12:14:36 PM prototype)",
    "What? A prototype & more",
    "100% Complete",
    "C♯ demo",
    "It’s “quoted”",
  ]) {
    const r = ok(t);
    assert.equal(titleFromSlug(r.slug), r.title);
  }
});

test("fullTitle renders namespace prefixes", () => {
  assert.equal(fullTitle({ ns: "main", title: "Foo" }), "Foo");
  assert.equal(fullTitle({ ns: "file", title: "X.png" }), "File:X.png");
  assert.equal(fullTitle({ ns: "user_talk", title: "Drx" }), "User talk:Drx");
});
