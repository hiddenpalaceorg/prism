import { test } from "node:test";
import assert from "node:assert/strict";
import { tlshDiff } from "../src/lib/tlsh";
import { hexToId63, toSigned64, lshBands, setJaccard, minhashJaccard, flattenFiles } from "../src/lib/fingerprint";
import type { Node } from "../src/lib/types";
import { TIERS, fusedScore, applicableTiers, type TierKey } from "../src/lib/tiers";

// Real fixtures generated with py-tlsh (the reference implementation) — this pins the
// pure-JS tlshDiff to the canonical distances.
const DA = "T19481953E00A63DF7D144A14C92F36575FB30450AEF5C77D0115B447D4D14C55043D217";
const DB = "T19E818F3E00AA3DF7E184A19C96F365B5FB30590AEF9C77D0129B44BD8D19C59083E21B";
const DC = "T1E1812B005919746DA41CD2D982AEE882CD6B0D28641696865312A2AC30E710CCA0C5B8";

test("tlshDiff matches py-tlsh reference distances", () => {
  assert.equal(tlshDiff(DA, DA), 0);
  assert.equal(tlshDiff(DA, DB), 82);
  assert.equal(tlshDiff(DA, DC), 341);
  assert.equal(tlshDiff(DB, DC), 298);
  // symmetric
  assert.equal(tlshDiff(DB, DA), tlshDiff(DA, DB));
});

test("tlshDiff returns null on malformed digests", () => {
  assert.equal(tlshDiff("nope", DA), null);
});

test("hexToId63 takes the first 8 bytes, masked to 63 bits", () => {
  assert.equal(hexToId63("0000000000000010ffffffffffffffff"), 16n);
  assert.equal(hexToId63("ffffffffffffffff"), (1n << 63n) - 1n); // top bit masked off
  assert.equal(hexToId63(null), null);
  assert.equal(hexToId63(""), null);
});

test("toSigned64 reinterprets the u64 bit pattern", () => {
  assert.equal(toSigned64(0xffffffffffffffffn), -1n);
  assert.equal(toSigned64(0n), 0n);
});

test("lshBands folds a 128-slot signature into 16 deterministic bands", () => {
  const sig = Array.from({ length: 128 }, (_, i) => BigInt(i * 2654435761));
  const a = lshBands(sig);
  const b = lshBands(sig);
  assert.equal(a.length, 16);
  assert.deepEqual(a, b); // deterministic
  // a different signature yields different bands
  const sig2 = sig.slice();
  sig2[0] = 999999n;
  assert.notDeepEqual(lshBands(sig2), a);
});

test("flattenFiles keeps an archive-dir's own row alongside its members", () => {
  const tree: Node[] = [
    {
      type: "dir",
      name: "DATA",
      children: [
        {
          // An archive listed as a directory: carries the archive file's hashes.
          type: "dir",
          name: "PROTO.ZIP",
          size: 100,
          sha1: "aa".repeat(20),
          children: [{ type: "file", name: "main.c", size: 5, sha1: "bb".repeat(20) }],
        },
        { type: "file", name: "GAME.BIN", size: 7, sha1: "cc".repeat(20) },
      ],
    },
  ];
  const rows = flattenFiles(tree);
  assert.deepEqual(
    rows.map((r) => r.path),
    ["/DATA/PROTO.ZIP", "/DATA/PROTO.ZIP/main.c", "/DATA/GAME.BIN"]
  );
  // A plain directory (no hashes) still contributes no row of its own.
  assert.equal(rows.some((r) => r.path === "/DATA"), false);
});

test("setJaccard = intersection / union", () => {
  assert.equal(setJaccard([1, 2, 3], [2, 3, 4]), 0.5); // 2 / 4
  assert.equal(setJaccard([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(setJaccard([1, 2], [3, 4]), 0);
  assert.equal(setJaccard([], [1]), 0);
});

test("minhashJaccard = fraction of positionally-equal slots", () => {
  assert.equal(minhashJaccard(["1", "2", "3", "4"], ["1", "2", "3", "4"]), 1);
  assert.equal(minhashJaccard(["1", "2", "3", "4"], ["1", "2", "9", "9"]), 0.5);
  assert.equal(minhashJaccard(["1"], ["1", "2"]), 0); // length mismatch
});

test("tier weights sum to 1.0 (a full match scores 100%)", () => {
  const total = TIERS.reduce((s, t) => s + t.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

test("fusedScore is the weighted-portion sum with all tiers active", () => {
  const all = new Set<TierKey>(TIERS.map((t) => t.key));
  // perfect match on every tier => 100%
  const perfect = Object.fromEntries(TIERS.map((t) => [t.key, 1]));
  assert.equal(fusedScore(perfect, all), 1);
  // files (0.20) full + resemblance (0.15) full, nothing else => 0.35
  assert.ok(Math.abs(fusedScore({ files: 1, resemblance: 1 }, all) - 0.35) < 1e-9);
});

test("fusedScore renormalizes to the active subset when filtering", () => {
  // Only 'resemblance' selected: its sim fills 100% regardless of its base weight.
  assert.equal(fusedScore({ files: 0.3, resemblance: 0.8 }, new Set<TierKey>(["resemblance"])), 0.8);
  // No tiers selected => 0.
  assert.equal(fusedScore({ files: 1 }, new Set<TierKey>()), 0);
});

test("applicableTiers = active ∩ both builds' capabilities", () => {
  const all = new Set<TierKey>(TIERS.map((t) => t.key));
  const queryNoExe: TierKey[] = ["content", "files", "chunks", "resemblance", "audio", "text"];
  const neighborAll: TierKey[] = TIERS.map((t) => t.key);
  const ap = applicableTiers(all, queryNoExe, neighborAll);
  assert.ok(!ap.has("imphash") && !ap.has("tlsh"), "exe tiers dropped when query lacks an exe");
  assert.ok(ap.has("files") && ap.has("content"));
  // the active filter further restricts
  assert.deepEqual([...applicableTiers(new Set<TierKey>(["files"]), queryNoExe, neighborAll)], ["files"]);
});

test("a tier absent from either build is dropped from the denominator (not penalized)", () => {
  const all = new Set<TierKey>(TIERS.map((t) => t.key));
  // both builds only have content data → content is the only applicable tier
  const caps: TierKey[] = ["content"];
  const ap = applicableTiers(all, caps, caps);
  assert.equal(fusedScore({ content: 1 }, ap), 1); // 100%, not diluted by the 7 missing tiers
  // neighbor missing audio: audio excluded even though query has it
  const ap2 = applicableTiers(all, ["files", "audio"], ["files"]);
  assert.equal(fusedScore({ files: 0.5 }, ap2), 0.5);
});

// --- fusion filtering ---------------------------------------------------------

import { fuseSimilar } from "../src/lib/queries";
import type { SimilarityResult } from "../src/lib/types";

const emptySimilarity = (): SimilarityResult => ({
  identical_content: [], shared_files: [], similar_chunks: [], resemblance: [], exe_imports: [], exe_similar: [], audio_neighbors: [],
});

test("text-only neighbors below 70% are dropped; others survive", () => {
  const s = emptySimilarity();
  s.shared_files = [{ sha256: "c".repeat(64), name: "files+weak text", system: "test", jaccard: 0.4 }];
  const fused = fuseSimilar(s, [
    { sha256: "a".repeat(64), name: "weak text only", system: "test", cosine: 0.6 },
    { sha256: "b".repeat(64), name: "strong text only", system: "test", cosine: 0.8 },
    { sha256: "c".repeat(64), name: "files+weak text", system: "test", cosine: 0.6 },
  ]);
  const shas = fused.map((f) => f.sha256);
  assert.ok(!shas.includes("a".repeat(64)), "weak text-only neighbor dropped");
  assert.ok(shas.includes("b".repeat(64)), "text-only neighbor at ≥0.7 kept");
  assert.ok(shas.includes("c".repeat(64)), "weak text kept when another tier also matched");
});

// --- asset ingest semantics -------------------------------------------------
// ingestRecord against a fake Queryable: assets == null means "extraction never
// ran" and must not touch existing build_asset rows; only an extracted list
// (even an empty one) is authoritative and replaces them.

import { ingestRecord } from "../src/lib/ingest";
import type { BuildRecord, AssetRef } from "../src/lib/types";

function minimalRecord(assets?: AssetRef[] | null): BuildRecord {
  const rec: BuildRecord = {
    record_schema_version: 1,
    fingerprint_profile: "v1",
    // Empty name + text_doc keep semanticDoc empty, so ingest skips the
    // embedding model and the test stays hermetic.
    image: { name: "", size: 0, md5: "", sha1: "", sha256: "ab".repeat(32) },
    info: { system: "test" },
    composites: {},
    structural: { system: "test", file_count: 0, total_size: 0, max_depth: 0, ext_histogram: {} },
    text_doc: "",
    contents: [],
  };
  if (assets !== undefined) rec.assets = assets;
  return rec;
}

function fakeDb() {
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

test("ingest with assets missing/null never touches build_asset", async () => {
  for (const rec of [minimalRecord(), minimalRecord(null)]) {
    const db = fakeDb();
    await ingestRecord(db, rec);
    assert.ok(db.calls.length > 0);
    assert.ok(!db.calls.some((c) => c.sql.includes("build_asset")));
  }
});

test("ingest with assets [] clears build_asset (extracted, nothing viewable)", async () => {
  const db = fakeDb();
  await ingestRecord(db, minimalRecord([]));
  assert.ok(db.calls.some((c) => c.sql.startsWith("DELETE FROM build_asset")));
  assert.ok(!db.calls.some((c) => c.sql.includes("INSERT INTO build_asset")));
});

test("ingest sets private only on insert, per asPrivate", async () => {
  for (const asPrivate of [true, false]) {
    const db = fakeDb();
    await ingestRecord(db, minimalRecord(), { asPrivate });
    const insert = db.calls.find((c) => c.sql.includes("INSERT INTO builds"));
    assert.ok(insert!.sql.includes("private"));
    assert.equal(insert!.params![insert!.params!.length - 1], asPrivate);
    // ON CONFLICT must not touch private: re-accepts keep moderator-set visibility.
    const onConflict = insert!.sql.slice(insert!.sql.indexOf("ON CONFLICT"));
    assert.ok(!onConflict.includes("private"));
  }
});

test("ingest keeps well-formed asset rows and drops malformed ones", async () => {
  const good: AssetRef = { path: "/A.PNG", sha256: "cd".repeat(32), size: 10, mime: "image/png", kind: "image" };
  const badSha = { path: "/B.PNG", sha256: "../etc/passwd", size: 10, mime: "image/png", kind: "image" } as AssetRef;
  const db = fakeDb();
  await ingestRecord(db, minimalRecord([good, badSha]));
  const inserts = db.calls.filter((c) => c.sql.includes("INSERT INTO build_asset"));
  assert.equal(inserts.length, 1);
  assert.ok(inserts[0].params!.includes("/A.PNG"));
  assert.ok(!inserts[0].params!.includes("/B.PNG"));
});

// --- asset grouping helpers ---------------------------------------------------

import { orderAssets, assetTotals, publicAssetUrl } from "../src/lib/assets";

test("publicAssetUrl hands off sniffable media and nothing else", () => {
  const sha = "ab".repeat(32);
  delete process.env.ASSET_PUBLIC_BASE;
  assert.equal(publicAssetUrl(sha, "image/png"), null); // no gateway configured
  process.env.ASSET_PUBLIC_BASE = "https://curator.example.org/";
  try {
    assert.equal(publicAssetUrl(sha, "image/png"), `https://curator.example.org/ab/${sha}`);
    assert.ok(publicAssetUrl(sha, "audio/ogg"));
    assert.ok(publicAssetUrl(sha, "video/mp4"));
    // Needs the app's Content-Type/Disposition/CSP headers — no handoff.
    assert.equal(publicAssetUrl(sha, "text/plain"), null);
    assert.equal(publicAssetUrl(sha, "application/pdf"), null);
    assert.equal(publicAssetUrl(sha, "application/octet-stream"), null);
    assert.equal(publicAssetUrl(sha, "image/svg+xml"), null);
  } finally {
    delete process.env.ASSET_PUBLIC_BASE;
  }
});

test("orderAssets groups by display kind and caps per kind", () => {
  const mk = (kind: string, n: number) => Array.from({ length: n }, (_, i) => ({ kind, path: `${kind}${i}` }));
  const mixed = [...mk("text", 3), ...mk("image", 12), ...mk("source", 2), ...mk("audio", 1)];
  const ordered = orderAssets(mixed, 10);
  assert.deepEqual(
    ordered.map((a) => a.kind),
    [...Array(10).fill("image"), "audio", ...Array(2).fill("source"), ...Array(3).fill("text")]
  );
  // Uncapped keeps everything, still grouped.
  assert.equal(orderAssets(mixed).length, 18);
  assert.deepEqual(assetTotals(mixed), { text: 3, image: 12, source: 2, audio: 1 });
});

test("orderAssets accepts a per-kind cap map (missing kind = uncapped)", () => {
  const mk = (kind: string, n: number) => Array.from({ length: n }, (_, i) => ({ kind, path: `${kind}${i}` }));
  const mixed = [...mk("image", 40), ...mk("audio", 25), ...mk("text", 12)];
  const ordered = orderAssets(mixed, { image: 30, audio: 20 });
  const counts: Record<string, number> = {};
  for (const a of ordered) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  assert.deepEqual(counts, { image: 30, audio: 20, text: 12 });
});

// --- submission asset uploads ---------------------------------------------------

import { referencedAssets, MAX_ASSET_BLOB_BYTES, MAX_VIDEO_BLOB_BYTES } from "../src/lib/submission-assets";
import type { Pool } from "pg";

function fakePool(subRow?: { record: BuildRecord; status: string }, buildRow?: { record: BuildRecord }) {
  return {
    query: async (sql: string) => {
      if (sql.includes("submission_queue")) return { rowCount: subRow ? 1 : 0, rows: subRow ? [subRow] : [] };
      if (sql.includes("FROM builds")) return { rowCount: buildRow ? 1 : 0, rows: buildRow ? [buildRow] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
}

test("referencedAssets dedupes shared blobs and drops malformed refs", async () => {
  const sha = "ef".repeat(32);
  const assets: AssetRef[] = [
    { path: "/A.PNG", sha256: sha, size: 10, mime: "image/png", kind: "image" },
    { path: "/COPY.PNG", sha256: sha, size: 10, mime: "image/png", kind: "image" }, // dup blob
    { path: "/B.PNG", sha256: "not-hex", size: 10, mime: "image/png", kind: "image" },
    { path: "/C.PNG", sha256: "aa".repeat(32), size: 0, mime: "image/png", kind: "image" },
    { path: "/D.PNG", sha256: "bb".repeat(32), size: MAX_ASSET_BLOB_BYTES + 1, mime: "image/png", kind: "image" },
    // Videos alone get the DVD-VOB-scale allowance.
    { path: "/V1.VOB", sha256: "11".repeat(32), size: MAX_ASSET_BLOB_BYTES + 1, mime: "video/mpeg", kind: "video" },
    { path: "/V2.VOB", sha256: "22".repeat(32), size: MAX_VIDEO_BLOB_BYTES + 1, mime: "video/mpeg", kind: "video" },
  ];
  const refs = await referencedAssets(fakePool({ record: minimalRecord(assets), status: "queued" }), "ab".repeat(32));
  assert.ok(refs);
  assert.deepEqual(
    [...refs.sizes.entries()],
    [
      [sha, 10],
      ["11".repeat(32), MAX_ASSET_BLOB_BYTES + 1],
    ]
  );
  assert.equal(refs.totalBytes, 10 + MAX_ASSET_BLOB_BYTES + 1);
});

test("referencedAssets falls back from rejected submission to the library build", async () => {
  const subAsset: AssetRef = { path: "/S", sha256: "cc".repeat(32), size: 1, mime: "text/plain", kind: "text" };
  const libAsset: AssetRef = { path: "/L", sha256: "dd".repeat(32), size: 2, mime: "text/plain", kind: "text" };
  const pool = fakePool(
    { record: minimalRecord([subAsset]), status: "rejected" },
    { record: minimalRecord([libAsset]) }
  );
  const refs = await referencedAssets(pool, "ab".repeat(32));
  assert.ok(refs);
  assert.deepEqual([...refs.sizes.keys()], ["dd".repeat(32)]);
  // Unknown everywhere -> null.
  assert.equal(await referencedAssets(fakePool(), "ab".repeat(32)), null);
});
