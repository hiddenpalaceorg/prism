/**
 * MCP server (via in-memory transport) + localDir storage adapter tests.
 * Uses its own scratch DB (cube_test_mcp); skips without Postgres.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pg from "pg";
import { createCube, type Cube } from "../src/index";
import { createCubeMcpServer } from "../src/mcp/index";
import { localDirStorage } from "../src/storage";
import { testComponents } from "./helpers";

const DB = "cube_test_mcp";
let pool: pg.Pool;
let cube: Cube;
let client: Client;
let available = true;

before(async () => {
  const admin = new pg.Pool({ database: "postgres" });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } catch (err) {
    available = false;
    console.log(`# skipping mcp tests: ${(err as Error).message}`);
    return;
  } finally {
    await admin.end();
  }
  pool = new pg.Pool({ database: DB });
  await pool.query(readFileSync(new URL("../db/migrations/001-init.sql", import.meta.url), "utf8"));
  cube = createCube({ db: { pool }, components: testComponents });

  const server = createCubeMcpServer(cube, { user: { id: 1, name: "Agent", roles: ["moderator"] } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await pool?.end();
});

function skippable(name: string, fn: () => Promise<void>) {
  test(name, { skip: !available && "postgres unavailable" }, fn);
}

function firstText(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]!.text;
}

skippable("tools are registered", async () => {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "create_page",
    "diff_revisions",
    "get_page",
    "get_revision",
    "list_components",
    "list_revisions",
    "query_objects",
    "search_pages",
    "update_page",
  ]);
});

skippable("agent workflow: introspect, create, self-correct, query", async () => {
  const components = JSON.parse(firstText(await client.callTool({ name: "list_components", arguments: {} })));
  assert.ok(components.some((c: { name: string }) => c.name === "Prototype"));

  // First attempt has a bad attr -> validation errors as tool RESULT.
  const bad = await client.callTool({
    name: "create_page",
    arguments: {
      title: "Agent Test (proto)",
      markdown: `<Prototype game="Agent Game" buildDate="last tuesday" />\n`,
    },
  });
  const badBody = JSON.parse(firstText(bad));
  assert.ok(badBody.validationErrors.some((i: { attr: string; line: number }) => i.attr === "buildDate" && i.line === 1));

  // Corrected attempt succeeds.
  const good = await client.callTool({
    name: "create_page",
    arguments: {
      title: "Agent Test (proto)",
      markdown: `<Prototype game="Agent Game" system="Sega Saturn" buildDate="1996-11" />\n\nWritten by an agent.\n`,
      comment: "agent create",
    },
  });
  const goodBody = JSON.parse(firstText(good));
  assert.ok(goodBody.revision > 0);

  const page = JSON.parse(firstText(await client.callTool({ name: "get_page", arguments: { title: "Agent Test (proto)" } })));
  assert.match(page.markdown, /Agent Game/);

  const update = await client.callTool({
    name: "update_page",
    arguments: {
      title: "Agent Test (proto)",
      markdown: page.markdown + "\nMore prose.\n",
      baseRevision: page.revision,
      comment: "agent edit",
    },
  });
  assert.ok(JSON.parse(firstText(update)).revision > goodBody.revision);

  const q = JSON.parse(
    firstText(
      await client.callTool({
        name: "query_objects",
        arguments: { from: "Prototype", where: { system: "Sega Saturn" } },
      }),
    ),
  );
  assert.equal(q.rows.length, 1);
  assert.equal(q.rows[0].data.game, "Agent Game");

  const hits = JSON.parse(firstText(await client.callTool({ name: "search_pages", arguments: { query: "Agent" } })));
  assert.ok(hits.length > 0);

  const revs = JSON.parse(
    firstText(await client.callTool({ name: "list_revisions", arguments: { title: "Agent Test (proto)" } })),
  );
  assert.equal(revs.length, 2);

  const diff = JSON.parse(
    firstText(await client.callTool({ name: "diff_revisions", arguments: { from: revs[1].id, to: revs[0].id } })),
  );
  assert.ok(diff.changes.some((c: { added?: boolean }) => c.added));
});

skippable("read-only server refuses write tool registration", async () => {
  const server = createCubeMcpServer(cube, {});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const ro = new Client({ name: "ro", version: "0.0.0" });
  await ro.connect(ct);
  const tools = await ro.listTools();
  assert.ok(!tools.tools.some((t) => t.name === "create_page"));
  await ro.close();
});

/* ---- storage: local dir (pure fs, no DB needed) ---- */

test("localDirStorage: put/get/has/delete round-trip, streams and buffers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cube-store-"));
  const store = localDirStorage({ dir, publicBase: "https://media.example" });

  await store.put("ab/cdef.png", Buffer.from("fake png"));
  assert.ok(await store.has("ab/cdef.png"));
  const got = await store.get("ab/cdef.png");
  assert.ok(got);
  let data = "";
  for await (const chunk of got!.body) data += chunk;
  assert.equal(data, "fake png");

  await store.put("streamed.bin", Readable.from([Buffer.from("part1-"), Buffer.from("part2")]));
  const streamed = await store.get("streamed.bin");
  let s = "";
  for await (const chunk of streamed!.body) s += chunk;
  assert.equal(s, "part1-part2");

  assert.equal(store.publicUrl("ab/cdef.png"), "https://media.example/ab/cdef.png");
  assert.equal(localDirStorage({ dir }).publicUrl("x"), null);

  await store.delete("ab/cdef.png");
  assert.ok(!(await store.has("ab/cdef.png")));
  assert.equal(await store.get("ab/cdef.png"), null);
});

test("localDirStorage rejects path traversal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cube-store-"));
  const store = localDirStorage({ dir });
  await assert.rejects(store.put("../escape.txt", Buffer.from("nope")));
  await assert.rejects(store.get("../../etc/passwd"));
});
