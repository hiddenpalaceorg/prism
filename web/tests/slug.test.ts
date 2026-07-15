import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHORT_SHA_LEN,
  slugify,
  canonicalBuildId,
  buildHref,
  assetHref,
  normalizeAssetPath,
  parseBuildParam,
  safeDecodeSegment,
} from "../src/lib/slug";

const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const SHORT = SHA.slice(0, SHORT_SHA_LEN);

test("slugify lowercases, strips punctuation and diacritics", () => {
  assert.equal(slugify("Sonic Adventure (Prototype)"), "sonic-adventure-prototype");
  assert.equal(slugify("Pokémon Café Mix!!"), "pokemon-cafe-mix");
  assert.equal(slugify("  --- "), "");
  assert.equal(slugify("A_B.C/D"), "a-b-c-d");
});

test("slugify caps length without leaving a trailing dash", () => {
  const s = slugify("x".repeat(70) + " " + "y".repeat(30));
  assert.ok(s.length <= 80);
  assert.ok(!s.endsWith("-"));
});

test("canonicalBuildId is short sha + slug (short sha alone when slug is empty)", () => {
  assert.equal(canonicalBuildId(SHA, "Cool Proto"), `${SHORT}-cool-proto`);
  assert.equal(canonicalBuildId(SHA, "!!!"), SHORT);
  assert.equal(buildHref(SHA, "Cool Proto"), `/builds/${SHORT}-cool-proto`);
});

test("parseBuildParam splits hex prefix and slug", () => {
  assert.deepEqual(parseBuildParam(`${SHORT}-cool-proto`), { hex: SHORT, slug: "cool-proto" });
  assert.deepEqual(parseBuildParam(SHORT), { hex: SHORT, slug: null });
  assert.deepEqual(parseBuildParam(SHA), { hex: SHA, slug: null });
  // uppercase hex is accepted and normalized
  assert.deepEqual(parseBuildParam(SHORT.toUpperCase()), { hex: SHORT, slug: null });
  // slugs that start with hex chars still split at the first dash
  assert.deepEqual(parseBuildParam(`${SHORT}-cafe-2000`), { hex: SHORT, slug: "cafe-2000" });
});

test("parseBuildParam rejects malformed params", () => {
  assert.equal(parseBuildParam("not-a-build"), null);
  assert.equal(parseBuildParam("abc123"), null); // too short (<8 hex)
  assert.equal(parseBuildParam(""), null);
  assert.equal(parseBuildParam(`${SHA}ff`), null); // >64 hex chars
});

test("canonical ids round-trip through parseBuildParam", () => {
  for (const name of ["Cool Proto", "deadbeef-styled name", "007", ""]) {
    const id = canonicalBuildId(SHA, name);
    const p = parseBuildParam(id);
    assert.ok(p, `parse failed for ${id}`);
    assert.equal(p.hex, SHORT);
  }
});

test("assetHref encodes each path segment and drops the stored leading slash", () => {
  assert.equal(
    assetHref("/builds/x", "DATA/My File #1.png"),
    "/builds/x/assets/DATA/My%20File%20%231.png"
  );
  assert.equal(assetHref("/builds/x", "/FOF/BGM/ABOUT.OGG"), "/builds/x/assets/FOF/BGM/ABOUT.OGG");
});

test("normalizeAssetPath strips only leading slashes", () => {
  assert.equal(normalizeAssetPath("/FOF/BGM/A.OGG"), "FOF/BGM/A.OGG");
  assert.equal(normalizeAssetPath("FOF/BGM/A.OGG"), "FOF/BGM/A.OGG");
});

test("safeDecodeSegment decodes but passes through raw percent signs", () => {
  assert.equal(safeDecodeSegment("My%20File"), "My File");
  assert.equal(safeDecodeSegment("100%.txt"), "100%.txt");
});
