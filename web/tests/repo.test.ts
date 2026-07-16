import { test } from "node:test";
import assert from "node:assert/strict";
import {
  indexManifest,
  resolveRev,
  entryAt,
  treeNodesAt,
  ancestorSet,
  commitsPage,
  commitChanges,
  fileLog,
  formatCommitDate,
  commitSubject,
  type RepoManifest,
  type RepoIdent,
} from "../src/lib/repo-manifest";
import { buildTree, findByPath } from "../src/lib/filetree";

// Synthetic five-commit history exercising every transition the viewer cares
// about: a root commit, a modify, a delete + binary add, a side branch, and a
// merge that brings the side branch's file in.
//
//   c1 (root) ── c2 ── c3 ──── c5 (merge, HEAD, "main")
//         └───── c4 ──────────┘
//
// oids are synthetic 40-hex strings from repeated seeds.
const O = (seed: string) => seed.repeat(40 / seed.length);
const C1 = O("1");
const C2 = O("2");
const C3 = O("3");
const C4 = O("4");
const C5 = "4444" + "5".repeat(36); // shares a 4-char prefix with C4 (ambiguity test)

const ident = (time: number): RepoIdent => ({ name: "dev", email: "dev@example.com", time, tz: 0 });
const commit = (oid: string, tree: string, parents: string[], time: number, message: string) => ({
  oid,
  tree,
  parents,
  author: ident(time),
  committer: ident(time),
  message,
});

const MANIFEST: RepoManifest = {
  version: 1,
  name: "fixture",
  head: C5,
  headRef: "main",
  refs: [
    { name: "main", oid: C5 },
    { name: "v1", oid: C2 },
  ],
  // newest-first by committer time: c5(400), c3(300), c4(250), c2(200), c1(100)
  commits: [
    commit(C5, O("ee"), [C3, C4], 400, "merge side branch\n\ndetails"),
    commit(C3, O("dd"), [C2], 300, "drop README, add bin.dat"),
    commit(C4, O("ff"), [C1], 250, "side: add side.txt"),
    commit(C2, O("cc"), [C1], 200, "rework main.c, add util.h"),
    commit(C1, O("aa"), [], 100, "initial import"),
  ],
  trees: {
    [O("aa")]: [
      ["README", "blob", O("b1")],
      ["src", "tree", O("ab")],
    ],
    [O("ab")]: [["main.c", "blob", O("b2")]],
    [O("cc")]: [
      ["README", "blob", O("b1")],
      ["src", "tree", O("cd")],
    ],
    [O("cd")]: [
      ["main.c", "blob", O("b3")],
      ["util.h", "blob", O("b4")],
    ],
    [O("dd")]: [
      ["bin.dat", "blob", O("b5")],
      ["src", "tree", O("cd")],
    ],
    [O("ff")]: [
      ["README", "blob", O("b1")],
      ["side.txt", "blob", O("b6")],
      ["src", "tree", O("ab")],
    ],
    [O("ee")]: [
      ["bin.dat", "blob", O("b5")],
      ["side.txt", "blob", O("b6")],
      ["src", "tree", O("cd")],
    ],
  },
  blobs: {
    [O("b1")]: ["f".repeat(64), 12, 0],
    [O("b2")]: ["e".repeat(64), 100, 0],
    [O("b3")]: ["d".repeat(64), 140, 0],
    [O("b4")]: ["c".repeat(64), 40, 0],
    [O("b5")]: ["b".repeat(64), 2048, 1],
    [O("b6")]: ["a".repeat(64), 9, 0],
  },
};

const idx = indexManifest(MANIFEST);

test("resolveRev handles HEAD, refs, prefixes, and ambiguity", () => {
  assert.equal(resolveRev(idx, "HEAD"), C5);
  assert.equal(resolveRev(idx, ""), C5);
  assert.equal(resolveRev(idx, "main"), C5);
  assert.equal(resolveRev(idx, "v1"), C2);
  assert.equal(resolveRev(idx, C3), C3); // full oid
  assert.equal(resolveRev(idx, "3333"), C3); // unique prefix
  assert.equal(resolveRev(idx, "4444"), null); // ambiguous: C4 vs C5
  assert.equal(resolveRev(idx, "44445"), C5); // disambiguated
  assert.equal(resolveRev(idx, "beef"), null); // unknown
  assert.equal(resolveRev(idx, "no-such-ref"), null);
  assert.equal(resolveRev(idx, "123"), null); // too short for a prefix
});

test("entryAt descends trees and misses cleanly", () => {
  assert.deepEqual(entryAt(idx, C1, "src/main.c"), { type: "blob", oid: O("b2") });
  assert.deepEqual(entryAt(idx, C2, "src/main.c"), { type: "blob", oid: O("b3") });
  assert.deepEqual(entryAt(idx, C2, "src"), { type: "tree", oid: O("cd") });
  assert.equal(entryAt(idx, C3, "README"), null); // deleted by c3
  assert.equal(entryAt(idx, C1, "src/main.c/impossible"), null); // descend through a blob
  assert.equal(entryAt(idx, C1, "nope"), null);
});

test("treeNodesAt feeds buildTree/findByPath unchanged", () => {
  // buildTree paths carry a leading "/" (the record-contents convention);
  // manifest paths don't — routes bridge with normalizeAssetPath.
  const roots = buildTree(treeNodesAt(idx, C2));
  const main = findByPath(roots, "/src/main.c");
  assert.ok(main && !main.dir);
  assert.equal(main.size, 140); // size joined from the blobs map
  const src = findByPath(roots, "/src");
  assert.ok(src && src.dir);
  assert.equal(src.fileCount, 2);
  assert.equal(findByPath(roots, "/bin.dat"), null); // not there yet at c2
});

test("ancestorSet includes merge parents", () => {
  assert.deepEqual(ancestorSet(idx, C5), new Set([C1, C2, C3, C4, C5]));
  assert.deepEqual(ancestorSet(idx, C4), new Set([C1, C4]));
});

test("commitsPage filters to the reachable subgraph, newest-first", () => {
  const head = commitsPage(idx, C5, 0, 10);
  assert.equal(head.total, 5);
  assert.deepEqual(
    head.commits.map((c) => c.oid),
    [C5, C3, C4, C2, C1]
  );
  const side = commitsPage(idx, C4, 0, 10);
  assert.equal(side.total, 2);
  assert.deepEqual(
    side.commits.map((c) => c.oid),
    [C4, C1]
  );
  const page = commitsPage(idx, C5, 1, 2);
  assert.deepEqual(
    page.commits.map((c) => c.oid),
    [C3, C4]
  );
  assert.equal(page.total, 5);
});

test("fileLog: modify chain down to the root add", () => {
  assert.deepEqual(fileLog(idx, C5, "src/main.c"), [
    { oid: C2, change: "modify", blob: O("b3") },
    { oid: C1, change: "add", blob: O("b2") },
  ]);
});

test("fileLog: deletions carry a null blob", () => {
  assert.deepEqual(fileLog(idx, C5, "README"), [
    { oid: C3, change: "delete", blob: null },
    { oid: C1, change: "add", blob: O("b1") },
  ]);
});

test("fileLog: side-branch changes attribute to the merge (first-parent)", () => {
  assert.deepEqual(fileLog(idx, C5, "side.txt"), [{ oid: C5, change: "add", blob: O("b6") }]);
});

test("fileLog from an old rev sees only its past", () => {
  assert.deepEqual(fileLog(idx, C2, "src/util.h"), [{ oid: C2, change: "add", blob: O("b4") }]);
  assert.deepEqual(fileLog(idx, C1, "src/util.h"), []);
});

test("commitChanges: root commit adds everything, path-sorted", () => {
  assert.deepEqual(commitChanges(idx, C1), [
    { path: "README", change: "add", from: null, to: O("b1") },
    { path: "src/main.c", change: "add", from: null, to: O("b2") },
  ]);
});

test("commitChanges: modify and add across a shared subtree", () => {
  assert.deepEqual(commitChanges(idx, C2), [
    { path: "src/main.c", change: "modify", from: O("b2"), to: O("b3") },
    { path: "src/util.h", change: "add", from: null, to: O("b4") },
  ]);
});

test("commitChanges: delete plus binary add", () => {
  assert.deepEqual(commitChanges(idx, C3), [
    { path: "README", change: "delete", from: O("b1"), to: null },
    { path: "bin.dat", change: "add", from: null, to: O("b5") },
  ]);
});

test("commitChanges: merge diffs against the first parent only", () => {
  assert.deepEqual(commitChanges(idx, C5), [
    { path: "side.txt", change: "add", from: null, to: O("b6") },
  ]);
});

test("formatCommitDate renders in the identity's timezone", () => {
  assert.equal(formatCommitDate({ name: "", email: "", time: 0, tz: 0 }), "1970-01-01 00:00");
  // tz uses the JS getTimezoneOffset convention: UTC+2 -> -120
  assert.equal(formatCommitDate({ name: "", email: "", time: 0, tz: -120 }), "1970-01-01 02:00");
});

test("commitSubject takes the first line", () => {
  assert.equal(commitSubject("merge side branch\n\ndetails"), "merge side branch");
  assert.equal(commitSubject("one-liner"), "one-liner");
});
