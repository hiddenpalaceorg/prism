import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRegistry,
  defineComponent,
  normalizeAttrs,
  snakeCase,
  toSchemaJson,
} from "../src/schema/index";
import { Prototype, testPage, testRegistry } from "./helpers";

const ctx = { page: testPage };

test("defineComponent rejects bad names", () => {
  assert.throws(() => defineComponent({ name: "lowercase", placement: "block", attrs: {} }));
  assert.throws(() =>
    defineComponent({ name: "X", placement: "block", attrs: { BadAttr: { type: "string" } } }),
  );
  assert.throws(() =>
    defineComponent({ name: "X", placement: "block", attrs: { e: { type: "enum" } } }),
  );
});

test("registry detects data components and derives field keys", () => {
  assert.ok(testRegistry.isDataComponent("Prototype"));
  assert.ok(!testRegistry.isDataComponent("GameNav"));
  const fields = testRegistry.fields("Prototype");
  assert.ok(fields.has("game"));
  assert.ok(fields.has("build_date")); // camelCase -> snake_case
  assert.ok(fields.has("sort_number"));
  assert.equal(fields.get("build_date")!.sortType, "date");
  assert.equal(fields.get("sort_number")!.sortType, "numeric");
  assert.ok(fields.get("game")!.indexed);
  assert.ok(!fields.get("build_date")!.indexed);
});

test("snakeCase", () => {
  assert.equal(snakeCase("buildDate"), "build_date");
  assert.equal(snakeCase("originLot"), "origin_lot");
  assert.equal(snakeCase("game"), "game");
});

test("normalizeAttrs applies defaults, requireds, types", () => {
  const r = normalizeAttrs(Prototype, { game: "Sonic 2" }, ctx);
  assert.equal(r.errors.length, 0);
  assert.equal(r.values.sortNumber, 999999);
  assert.equal(r.values.game, "Sonic 2");

  const missing = normalizeAttrs(Prototype, {}, ctx);
  assert.ok(missing.errors.some((e) => e.attr === "game"));

  const badNum = normalizeAttrs(Prototype, { game: "X", sortNumber: "abc" }, ctx);
  assert.ok(badNum.errors.some((e) => e.attr === "sortNumber"));

  const numStr = normalizeAttrs(Prototype, { game: "X", sortNumber: "42" }, ctx);
  assert.equal(numStr.values.sortNumber, 42);
});

test("normalizeAttrs: unknown attr reported", () => {
  const r = normalizeAttrs(Prototype, { game: "X", bogus: "1" }, ctx);
  assert.ok(r.errors.some((e) => e.attr === "bogus"));
});

test("multi attrs accept arrays and comma strings", () => {
  const a = normalizeAttrs(Prototype, { game: "X", dumpedBy: "drx, evilhamwizard" }, ctx);
  assert.deepEqual(a.values.dumpedBy, ["drx", "evilhamwizard"]);
  const b = normalizeAttrs(Prototype, { game: "X", dumpedBy: ["drx"] }, ctx);
  assert.deepEqual(b.values.dumpedBy, ["drx"]);
});

test("date validation: partial ISO ok, garbage and impossible dates rejected", () => {
  const ok1 = normalizeAttrs(Prototype, { game: "X", buildDate: "1992" }, ctx);
  assert.equal(ok1.errors.length, 0);
  const ok2 = normalizeAttrs(Prototype, { game: "X", buildDate: "1992-05" }, ctx);
  assert.equal(ok2.errors.length, 0);
  const ok3 = normalizeAttrs(Prototype, { game: "X", buildDate: "1992-05-01" }, ctx);
  assert.equal(ok3.errors.length, 0);

  for (const bad of ["May 1992", "1992-13", "1992-02-30", "92-05-01"]) {
    const r = normalizeAttrs(Prototype, { game: "X", buildDate: bad }, ctx);
    assert.ok(r.errors.some((e) => e.attr === "buildDate"), `expected reject: ${bad}`);
  }
});

test("enum and boolean coercion", () => {
  const good = normalizeAttrs(Prototype, { game: "X", status: "Released", unreleased: "false" }, ctx);
  assert.equal(good.errors.length, 0);
  assert.equal(good.values.unreleased, false);
  const bad = normalizeAttrs(Prototype, { game: "X", status: "Nope" }, ctx);
  assert.ok(bad.errors.some((e) => e.attr === "status"));
});

test("duplicate component names rejected", () => {
  const X = defineComponent({ name: "X", placement: "block", attrs: {} });
  assert.throws(() => createRegistry([X, X]));
});

test("schema introspection JSON", () => {
  const json = toSchemaJson(testRegistry);
  const proto = json.find((c) => c.name === "Prototype")!;
  assert.equal(proto.attrs.game!.queryable!.key, "game");
  assert.equal(proto.attrs.game!.queryable!.indexed, true);
  assert.equal(proto.attrs.buildDate!.queryable!.key, "build_date");
  assert.equal(proto.attrs.status!.values!.length, 3);
});
