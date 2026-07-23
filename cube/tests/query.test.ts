import assert from "node:assert/strict";
import { test } from "node:test";
import { compileQuery, CubeQueryError, type Where } from "../src/query";
import { toObjectQuery } from "../src/query-component";
import { testRegistry } from "./helpers";

test("basic equality compiles with partial-index helper clause", () => {
  const c = compileQuery(testRegistry, { from: "Prototype", where: { game: "Sonic 2" } });
  assert.match(c.text, /o\.component = ANY\(\$1\)/);
  assert.match(c.text, /o\.data \? 'game'/); // the 270x seq-scan guard
  assert.match(c.text, /\(o\.data->>'game'\) = \$2/);
  assert.match(c.text, /p\.deleted_at IS NULL/);
  assert.match(c.text, /NOT p\.is_redirect/);
  assert.match(c.text, /p\.visibility = 'public'/);
  assert.deepEqual(c.values[0], ["Prototype"]);
  assert.equal(c.values[1], "Sonic 2");
});

test("typed sorts use the immutable cast helpers", () => {
  const c = compileQuery(testRegistry, {
    from: "Prototype",
    sort: [{ field: "sort_number" }, { field: "build_date", dir: "desc" }],
  });
  assert.match(c.text, /cube_num\(o\.data->>'sort_number'\) ASC NULLS LAST/);
  assert.match(c.text, /cube_date\(o\.data->>'build_date'\) DESC NULLS LAST/);
});

test("range ops cast typed fields", () => {
  const c = compileQuery(testRegistry, {
    from: "Prototype",
    where: { build_date: { gte: "1992", lt: "1993" }, sort_number: { lte: 10 } },
  });
  assert.match(c.text, /cube_date\(o\.data->>'build_date'\) >= cube_date\(\$\d\)/);
  assert.match(c.text, /cube_num\(o\.data->>'sort_number'\) <= \$\d::numeric/);
});

test("or / and / not, in, like, exists", () => {
  const c = compileQuery(testRegistry, {
    from: "Prototype",
    where: {
      or: [
        { system: { in: ["SNES", "Genesis"] } },
        { and: [{ game: { like: "Sonic*" } }, { not: { origin_lot: { exists: true } } }] },
      ],
    },
  });
  assert.match(c.text, / OR /);
  assert.match(c.text, /ILIKE/);
  assert.match(c.text, /NOT \(\(o\.data \? 'origin_lot'\)\)/);
  assert.equal(c.values.find((v) => v === "Sonic%"), "Sonic%");
});

test("multi-value fields use jsonb array membership", () => {
  const c = compileQuery(testRegistry, { from: "Prototype", where: { dumped_by: "drx" } });
  assert.match(c.text, /o\.data->'dumped_by' \? \$\d/);
});

test("multiple components union their field sets", () => {
  const c = compileQuery(testRegistry, { from: ["Prototype", "FileEntry"], where: { sha1: "abc" } });
  assert.deepEqual(c.values[0], ["Prototype", "FileEntry"]);
});

test("unknown fields and components throw with valid-field listing", () => {
  assert.throws(
    () => compileQuery(testRegistry, { from: "Prototype", where: { bogus: "x" } }),
    (e: unknown) => e instanceof CubeQueryError && /valid:.*game/.test(e.message),
  );
  assert.throws(() => compileQuery(testRegistry, { from: "Nope" }), CubeQueryError);
  assert.throws(
    () => compileQuery(testRegistry, { from: "Prototype", sort: [{ field: "nope" }] }),
    CubeQueryError,
  );
});

test("deeply nested where throws CubeQueryError, not a RangeError stack overflow", () => {
  let deep: Where = { game: "Sonic" };
  for (let i = 0; i < 5000; i++) deep = { and: [deep] };
  assert.throws(
    () => compileQuery(testRegistry, { from: "Prototype", where: deep }),
    (e: unknown) => e instanceof CubeQueryError && /nested too deeply/.test(e.message),
  );
});

test("aggregates: count, min/max, groupBy", () => {
  const count = compileQuery(testRegistry, { from: "Prototype", aggs: [{ fn: "count", as: "n" }] });
  assert.match(count.text, /count\(\*\)::bigint AS n/);

  const grouped = compileQuery(testRegistry, {
    from: "Prototype",
    groupBy: "origin_lot",
    aggs: [{ fn: "count", as: "n" }, { fn: "min", field: "build_date", as: "first" }, { fn: "max", field: "build_date", as: "last" }],
  });
  assert.match(grouped.text, /GROUP BY 1/);
  assert.match(grouped.text, /min\(cube_date\(o\.data->>'build_date'\)\) AS first/);
});

test("pseudo-fields", () => {
  const c = compileQuery(testRegistry, {
    from: "Prototype",
    sort: [{ field: "_created", dir: "desc" }],
    select: ["game"],
  });
  assert.match(c.text, /p\.created_at DESC/);
  assert.match(c.text, /jsonb_build_object\('game', o\.data->'game'\)/);
});

test("limit clamps and fetches one extra for truncation", () => {
  const c = compileQuery(testRegistry, { from: "Prototype", limit: 999999 });
  assert.equal(c.limit, 5000);
  assert.equal(c.values[c.values.length - 1], 5001);
});

test("page self-filter", () => {
  const c = compileQuery(testRegistry, {
    from: "Prototype",
    page: { ns: "main", slug: "X" },
  });
  assert.match(c.text, /p\.ns = \$2 AND p\.slug = \$3/);
});

test("toObjectQuery maps <Query> formats to DSL", () => {
  const count = toObjectQuery({ from: "Prototype", format: "count" });
  assert.deepEqual(count.aggs, [{ fn: "count", as: "count" }]);

  const earliest = toObjectQuery({ from: "Prototype", format: "earliest", of: "build_date" });
  assert.deepEqual(earliest.aggs, [{ fn: "min", field: "build_date", as: "value" }]);

  assert.throws(() => toObjectQuery({ from: "Prototype", format: "earliest" }), CubeQueryError);

  const sorted = toObjectQuery({ from: "Prototype", sort: ["-build_date", "game"] });
  assert.deepEqual(sorted.sort, [
    { field: "build_date", dir: "desc" },
    { field: "game", dir: "asc" },
  ]);
});

test("visibility filter drops for includeHidden", () => {
  const c = compileQuery(testRegistry, { from: "Prototype" }, { includeHidden: true });
  assert.doesNotMatch(c.text, /visibility/);
});
