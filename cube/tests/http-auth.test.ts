/**
 * Auth + HTTP API integration against a dedicated scratch DB (cube_test_http)
 * so it never races the main integration suite's DB. Skips without Postgres.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";
import { canonicalUsername, createUser, cubeNativeAuth, defaultCan } from "../src/auth/native";
import { hashPassword, needsRehash, verifyPassword } from "../src/auth/passwords";
import { createToken } from "../src/http/index";
import { createCube, type Cube } from "../src/index";
import { testComponents } from "./helpers";
import { createHash, pbkdf2Sync } from "node:crypto";

const DB = "cube_test_http";
let pool: pg.Pool;
let cube: Cube;
let available = true;

before(async () => {
  const admin = new pg.Pool({ database: "postgres" });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } catch (err) {
    available = false;
    console.log(`# skipping http/auth tests: ${(err as Error).message}`);
    return;
  } finally {
    await admin.end();
  }
  pool = new pg.Pool({ database: DB });
  await pool.query(readFileSync(new URL("../db/migrations/001-init.sql", import.meta.url), "utf8"));
  cube = createCube({
    db: { pool },
    components: testComponents,
    auth: cubeNativeAuth({ pool, secure: false }),
  });
});

after(async () => {
  await pool?.end();
});

function skippable(name: string, fn: () => Promise<void>) {
  test(name, { skip: !available && "postgres unavailable" }, fn);
}

/* ---- password formats (pure, no DB) ---- */

test("MW pbkdf2 hashes verify", () => {
  // Constructed in MW's storage format with its default params.
  const salt = Buffer.from("somesaltvalue123");
  const derived = pbkdf2Sync("hunter2", salt, 30000, 64, "sha512");
  const stored = `:pbkdf2:sha512:30000:64:${salt.toString("base64")}:${derived.toString("base64")}`;
  assert.ok(verifyPassword(stored, "hunter2"));
  assert.ok(!verifyPassword(stored, "hunter3"));
  assert.ok(needsRehash(stored));
});

test("MW legacy :B: and :A: hashes verify", () => {
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const b = `:B:1a2b:${md5(`1a2b-${md5("oldpass")}`)}`;
  assert.ok(verifyPassword(b, "oldpass"));
  assert.ok(!verifyPassword(b, "wrong"));
  const a = `:A:${md5("ancient")}`;
  assert.ok(verifyPassword(a, "ancient"));
  assert.ok(needsRehash(a));
});

test("scrypt hash round-trip, no rehash needed", () => {
  const h = hashPassword("secret phrase");
  assert.ok(verifyPassword(h, "secret phrase"));
  assert.ok(!verifyPassword(h, "Secret phrase"));
  assert.ok(!needsRehash(h));
});

test("canonicalUsername matches MW rules", () => {
  assert.equal(canonicalUsername("drx"), "Drx");
  assert.equal(canonicalUsername("  evil_ham  wizard "), "Evil ham wizard");
});

test("defaultCan policy", () => {
  const anon = null;
  const user = { id: 1, name: "U", roles: [] as string[] };
  const mod = { id: 2, name: "M", roles: ["moderator"] };
  assert.ok(defaultCan(anon, "read"));
  assert.ok(!defaultCan(anon, "edit"));
  assert.ok(defaultCan(user, "edit"));
  assert.ok(!defaultCan(user, "delete"));
  assert.ok(defaultCan(mod, "delete"));
  assert.ok(!defaultCan(user, "edit", { ns: "main", slug: "X", protection: { edit: "moderator" } }));
  assert.ok(mod && defaultCan(mod, "edit", { ns: "main", slug: "X", protection: { edit: "moderator" } }));
  assert.ok(!defaultCan(user, "read", { ns: "main", slug: "X", visibility: "moderator" }));
});

/* ---- session + HTTP flows ---- */

const API = "http://cube.test/api/cube";

function req(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  return new Request(`${API}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined && { "content-type": "application/json" }),
      ...(opts.raw !== undefined && { "content-type": "text/markdown" }),
      ...opts.headers,
    },
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    ...(opts.raw !== undefined && { body: opts.raw }),
  });
}

let sessionCookie = "";

skippable("register + login sets a session cookie", async () => {
  const user = await createUser(pool, { name: "drx", password: "hunter2" });
  assert.equal(user.name, "Drx");
  await createUser(pool, { name: "mod", password: "modpass", roles: ["moderator"] });

  const res = await cube.handlers.POST(req("POST", "/auth/login", { body: { name: "drx", password: "hunter2" } }));
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie")!;
  assert.match(setCookie, /cube_session=/);
  sessionCookie = setCookie.split(";")[0]!;

  const me = await cube.handlers.GET(
    req("GET", "/auth/me", { headers: { cookie: sessionCookie } }),
  );
  const body = (await me.json()) as { user: { name: string } };
  assert.equal(body.user.name, "Drx");
});

skippable("bad credentials rejected", async () => {
  const res = await cube.handlers.POST(req("POST", "/auth/login", { body: { name: "drx", password: "nope" } }));
  assert.equal(res.status, 401);
});

skippable("anonymous writes are forbidden; session without CSRF header rejected", async () => {
  const anon = await cube.handlers.PUT(
    req("PUT", "/page?title=New_Page", { body: { markdown: "hi\n" } }),
  );
  assert.equal(anon.status, 403);

  const noCsrf = await cube.handlers.PUT(
    req("PUT", "/page?title=New_Page", { body: { markdown: "hi\n" }, headers: { cookie: sessionCookie } }),
  );
  assert.equal(noCsrf.status, 403);
});

skippable("session write with CSRF header creates and edits a page", async () => {
  const csrf = { cookie: sessionCookie, "sec-fetch-site": "same-origin" };
  const create = await cube.handlers.PUT(
    req("PUT", "/page?title=Croc 2 (May 3, 1999 prototype)", {
      body: { markdown: `<Prototype game="Croc 2" system="PlayStation" buildDate="1999-05-03" />\n`, comment: "create" },
      headers: csrf,
    }),
  );
  assert.equal(create.status, 201);
  const { revision } = (await create.json()) as { revision: number };

  const edit = await cube.handlers.PUT(
    req("PUT", "/page?title=Croc_2_(May_3,_1999_prototype)", {
      body: {
        markdown: `<Prototype game="Croc 2" system="PlayStation" buildDate="1999-05-03" />\n\nNow with prose.\n`,
        baseRevision: revision,
        comment: "add prose",
      },
      headers: csrf,
    }),
  );
  assert.equal(edit.status, 200);

  const get = await cube.handlers.GET(req("GET", "/page?title=Croc 2 (May 3, 1999 prototype)"));
  assert.equal(get.status, 200);
  const page = (await get.json()) as { markdown: string; revision: number };
  assert.match(page.markdown, /Now with prose/);
});

skippable("validation failure returns the 422 envelope with line-accurate issues", async () => {
  const res = await cube.handlers.PUT(
    req("PUT", "/page?title=Bad Page", {
      body: { markdown: `line\n\n<Prototype buildDate="nope" />\n` },
      headers: { cookie: sessionCookie, "sec-fetch-site": "same-origin" },
    }),
  );
  assert.equal(res.status, 422);
  const body = (await res.json()) as { error: { code: string; issues: { line: number; attr?: string }[] } };
  assert.equal(body.error.code, "validation_failed");
  assert.ok(body.error.issues.some((i) => i.line === 3 && i.attr === "game"));
});

skippable("stale base returns 409 conflict envelope", async () => {
  const get = await cube.handlers.GET(req("GET", "/page?title=Croc 2 (May 3, 1999 prototype)"));
  const { revision } = (await get.json()) as { revision: number };
  const csrf = { cookie: sessionCookie, "sec-fetch-site": "same-origin" };

  await cube.handlers.PUT(
    req("PUT", "/page?title=Croc 2 (May 3, 1999 prototype)", {
      body: { markdown: `<Prototype game="Croc 2" system="PlayStation" />\n\nTheirs.\n`, baseRevision: revision },
      headers: csrf,
    }),
  );
  const conflict = await cube.handlers.PUT(
    req("PUT", "/page?title=Croc 2 (May 3, 1999 prototype)", {
      body: { markdown: `<Prototype game="Croc 2" system="PlayStation" />\n\nMine.\n`, baseRevision: revision },
      headers: csrf,
    }),
  );
  assert.equal(conflict.status, 409);
  const body = (await conflict.json()) as { error: { code: string; head: number; headContent: string } };
  assert.equal(body.error.code, "conflict");
  assert.match(body.error.headContent, /Theirs/);
});

skippable("raw text/markdown PUT works", async () => {
  const res = await cube.handlers.PUT(
    req("PUT", "/page?title=Raw Body Page", {
      raw: "Just some **markdown**.\n",
      headers: { cookie: sessionCookie, "sec-fetch-site": "same-origin" },
    }),
  );
  assert.equal(res.status, 201);
});

skippable("query endpoint runs and search finds pages", async () => {
  const q = await cube.handlers.POST(
    req("POST", "/query", { body: { from: "Prototype", where: { game: "Croc 2" } } }),
  );
  assert.equal(q.status, 200);
  const result = (await q.json()) as { kind: string; rows: unknown[] };
  assert.equal(result.kind, "rows");
  assert.equal(result.rows.length, 1);

  const bad = await cube.handlers.POST(req("POST", "/query", { body: { from: "Prototype", where: { nope: 1 } } }));
  assert.equal(bad.status, 422);

  const s = await cube.handlers.GET(req("GET", "/search?q=Croc"));
  const hits = (await s.json()) as { hits: { slug: string }[] };
  assert.ok(hits.hits.some((h) => h.slug.startsWith("Croc_2")));
});

skippable("revisions, revision, diff endpoints", async () => {
  const revs = await cube.handlers.GET(req("GET", "/revisions?title=Croc 2 (May 3, 1999 prototype)"));
  const { revisions } = (await revs.json()) as { revisions: { id: number }[] };
  assert.ok(revisions.length >= 3);

  const one = await cube.handlers.GET(req("GET", `/revision/${revisions[0]!.id}`));
  assert.equal(one.status, 200);

  const diff = await cube.handlers.GET(
    req("GET", `/diff?from=${revisions[1]!.id}&to=${revisions[0]!.id}`),
  );
  const d = (await diff.json()) as { changes: { added?: boolean }[] };
  assert.ok(d.changes.some((c) => c.added));
});

skippable("bearer tokens: scoped access, bad token rejected", async () => {
  const { token } = await createToken(pool, { name: "ci-bot", scopes: ["read", "query", "write"] });

  const write = await cube.handlers.PUT(
    req("PUT", "/page?title=Bot Page", {
      body: { markdown: "By the bot.\n" },
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(write.status, 201);

  const readOnly = await createToken(pool, { name: "reader", scopes: ["read", "query"] });
  const denied = await cube.handlers.PUT(
    req("PUT", "/page?title=Bot Page 2", {
      body: { markdown: "nope\n" },
      headers: { authorization: `Bearer ${readOnly.token}` },
    }),
  );
  assert.equal(denied.status, 403);

  const forged = await cube.handlers.GET(
    req("GET", "/auth/me", { headers: { authorization: `Bearer cube_1_forgedforgedforged` } }),
  );
  const body = (await forged.json()) as { user: { name: string } | null };
  assert.equal(body.user, null);
});

skippable("moderator-only delete via defaultCan", async () => {
  const deny = await cube.handlers.DELETE(
    req("DELETE", "/page?title=Bot Page", {
      body: {},
      headers: { cookie: sessionCookie, "sec-fetch-site": "same-origin" },
    }),
  );
  assert.equal(deny.status, 403);

  const login = await cube.handlers.POST(
    req("POST", "/auth/login", { body: { name: "mod", password: "modpass" } }),
  );
  const modCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const ok = await cube.handlers.DELETE(
    req("DELETE", "/page?title=Bot Page", {
      body: {},
      headers: { cookie: modCookie, "sec-fetch-site": "same-origin" },
    }),
  );
  assert.equal(ok.status, 200);
});

skippable("logout invalidates the session", async () => {
  await cube.handlers.POST(
    req("POST", "/auth/logout", { headers: { cookie: sessionCookie, "sec-fetch-site": "same-origin" } }),
  );
  const me = await cube.handlers.GET(req("GET", "/auth/me", { headers: { cookie: sessionCookie } }));
  const body = (await me.json()) as { user: unknown };
  assert.equal(body.user, null);
});
