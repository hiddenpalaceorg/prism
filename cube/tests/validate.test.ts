import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPage, queryDepsFromQueryAttrs } from "../src/extract";
import { parseDocument } from "../src/parse";
import { validateDocument } from "../src/validate";
import { testPage, testRegistry } from "./helpers";

function run(markdown: string, opts?: Parameters<typeof validateDocument>[3]) {
  const { root, issues: parseIssues } = parseDocument(markdown);
  assert.ok(root, JSON.stringify(parseIssues));
  const { issues, components } = validateDocument(testRegistry, root!, testPage, opts);
  return { root: root!, issues: [...parseIssues, ...issues], components };
}

test("valid document produces no issues and typed instances", () => {
  const { issues, components } = run(
    `<Prototype game="Sonic 2" system="Sega Mega Drive" buildDate="1992-05" dumpedBy="drx, ehw" />\n`,
  );
  assert.deepEqual(issues, []);
  assert.equal(components.length, 1);
  assert.equal(components[0]!.attrs.game, "Sonic 2");
  assert.deepEqual(components[0]!.attrs.dumpedBy, ["drx", "ehw"]);
  assert.equal(components[0]!.attrs.sortNumber, 999999);
});

test("unknown component errors with position", () => {
  const { issues } = run("text\n\n<Nope thing=\"x\" />\n");
  const issue = issues.find((i) => i.rule === "unknown-component")!;
  assert.equal(issue.severity, "error");
  assert.equal(issue.line, 3);
  assert.equal(issue.component, "Nope");
});

test("unknown component severity is configurable", () => {
  const { issues } = run("<Nope />\n", { unknownComponents: "warning" });
  assert.equal(issues[0]!.severity, "warning");
});

test("attr type errors carry attr + component + line", () => {
  const { issues } = run(`<Prototype game="X" buildDate="not a date" />\n`);
  const issue = issues.find((i) => i.rule === "attr")!;
  assert.equal(issue.attr, "buildDate");
  assert.equal(issue.component, "Prototype");
  assert.equal(issue.line, 1);
});

test("required attr missing errors", () => {
  const { issues } = run("<Prototype system=\"SNES\" />\n");
  assert.ok(issues.some((i) => i.attr === "game"));
});

test("placement: inline component used as block errors", () => {
  const { issues } = run(`<RegionDate region="JP" date="x" />\n`);
  assert.ok(issues.some((i) => i.rule === "placement"));
});

test("placement: inline component inline is fine", () => {
  const { issues } = run(`Released <RegionDate region="JP" date="Nov 21, 1992" /> in Japan.\n`);
  assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
});

test("children policy none rejects children", () => {
  const { issues } = run(`<Prototype game="X">\nstuff\n</Prototype>\n`);
  assert.ok(issues.some((i) => i.rule === "children"));
});

test("children policy json requires one valid fenced block", () => {
  const good = run('<HexDump>\n\n```json\n{"rows": []}\n```\n\n</HexDump>\n');
  assert.deepEqual(good.issues, []);
  assert.deepEqual(good.components[0]!.childrenJson, { rows: [] });

  const bad = run("<HexDump>\n\n```json\nnot json\n```\n\n</HexDump>\n");
  assert.ok(bad.issues.some((i) => i.rule === "children-json"));

  const missing = run("<HexDump>\ntext\n</HexDump>\n");
  assert.ok(missing.issues.some((i) => i.rule === "children"));
});

test("named children policy", () => {
  const good = run(
    `<FileList>\n<FileEntry filename="a.bin" size={1024} />\n<FileEntry filename="b.bin" />\n</FileList>\n`,
  );
  assert.deepEqual(good.issues, []);

  const bad = run(`<FileList>\n<Prototype game="X" />\n</FileList>\n`);
  assert.ok(bad.issues.some((i) => i.rule === "children"));
});

test("intrinsic tags: allowlist and attribute rules", () => {
  const ok = run("Some <b>bold</b> and <code>code</code>.\n");
  assert.deepEqual(ok.issues.filter((i) => i.severity === "error"), []);

  const badTag = run("a <blink>x</blink> b\n");
  assert.ok(badTag.issues.some((i) => i.rule === "intrinsic-tag"));

  const badAttr = run(`text <b onclick="x">bold</b>\n`);
  assert.ok(badAttr.issues.some((i) => i.rule === "intrinsic-attr"));
});

test("raw html nodes flagged as warning (rendered escaped)", () => {
  // <script> stays a raw html node (micromark html-flow wins for raw tags);
  // it never becomes an element: the renderer escapes it.
  const { issues } = run("<script>alert(1)</script>\n");
  assert.ok(issues.some((i) => i.rule === "raw-html" && i.severity === "warning"));
  assert.ok(!issues.some((i) => i.severity === "error"));
});

/* ---- extraction ---------------------------------------------------------- */

test("extraction: objects, derive fields, categories, warnings", () => {
  const { root, components } = run(
    `<Prototype game="Sonic 2" system="Sega Mega Drive" buildDate="1992-05" originLot="Altron lot" dumpedBy="drx" />\n\nBody [[Sonic the Hedgehog 2|link]] here.\n`,
  );
  const x = extractPage(testRegistry, root, components, testPage);

  assert.equal(x.objects.length, 1);
  const data = x.objects[0]!.data;
  assert.equal(data.game, "Sonic 2");
  assert.equal(data.build_date, "1992-05");
  assert.equal(data.sort_date, "1992-05"); // derive fallback
  assert.equal(data.sort_number, 999999);
  assert.deepEqual(data.dumped_by, ["drx"]);

  assert.ok(x.categories.includes("Sonic 2 prototypes"));
  assert.ok(x.categories.includes("Sega Mega Drive prototypes"));
  assert.ok(x.categories.includes("tracking/Missing title screenshots"));
  assert.ok(x.warnings.includes("Missing title screenshots"));

  assert.ok(x.links.some((l) => l.target === "Sonic the Hedgehog 2" && l.kind === "link"));
  assert.ok(x.links.some((l) => l.target === "Altron lot" && l.kind === "link"));
  assert.ok(x.searchDoc.includes("Sonic 2")); // searchable attr
  assert.ok(x.searchDoc.includes("Body"));
});

test("extraction: redirect, category, display title built-ins", () => {
  const { root, components } = run(
    `<Redirect to="Sonic the Hedgehog 2 (Nick Arcade prototype)" />\n`,
  );
  const x = extractPage(testRegistry, root, components, testPage);
  assert.equal(x.redirect?.target, "Sonic the Hedgehog 2 (Nick Arcade prototype)");

  const { root: r2, components: c2 } = run(
    `<Category name="Manually added" />\n<DisplayTitle title="Fancy" />\n\ntext\n`,
  );
  const x2 = extractPage(testRegistry, r2, c2, testPage);
  assert.ok(x2.categories.includes("Manually added"));
  assert.equal(x2.displayTitle, "Fancy");
});

test("extraction: query deps from <Query> and renderer-declared queries", () => {
  const { root, components } = run(
    `<Query from="Prototype" where={{"game": "Sonic 2"}} />\n\n<GameNav game="Sonic 2" />\n`,
  );
  const x = extractPage(testRegistry, root, components, testPage);
  assert.deepEqual(
    new Set(x.queryDeps.map((d) => `${d.component}|${d.filterKey}`)),
    new Set(["Prototype|game=Sonic 2"]),
  );
});

test("query dep filter keys prefer indexed equality, else component-wide", () => {
  const deps = queryDepsFromQueryAttrs(testRegistry, {
    from: "Prototype",
    where: { build_date: { gte: "1992" } },
  });
  assert.deepEqual(deps, [{ component: "Prototype", filterKey: null }]);
});

test("media attrs create media links", () => {
  const { root, components } = run(`<Prototype game="X" titleScreen="S2NA Title.png" />\n`);
  const x = extractPage(testRegistry, root, components, testPage);
  assert.ok(x.links.some((l) => l.kind === "media" && l.target === "S2NA Title.png"));
});
