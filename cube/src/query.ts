/**
 * The object query engine: SMW #ask's replacement. One DSL, three surfaces:
 * the <Query> component, the HTTP API, and MCP. Compiles to SQL over
 * cube_page_object with schema-driven field resolution: identifiers come only
 * from the registry, values only as bind parameters.
 */

import type { Pool } from "pg";
import type { QueryableField, Registry } from "./schema/index";

export type WhereScalar = string | number | boolean;

export interface WhereOps {
  eq?: WhereScalar;
  ne?: WhereScalar;
  in?: WhereScalar[];
  gt?: WhereScalar;
  gte?: WhereScalar;
  lt?: WhereScalar;
  lte?: WhereScalar;
  /** Glob match; * is the wildcard (SMW ~ / "like:"). */
  like?: string;
  exists?: boolean;
}

export type Where =
  | { and: Where[] }
  | { or: Where[] }
  | { not: Where }
  | { [field: string]: WhereScalar | WhereOps };

export interface ObjectQuery {
  /** Component name(s) to query. */
  from: string | string[];
  where?: Where;
  /** Data keys to project; omit for the full object. */
  select?: string[];
  sort?: { field: string; dir?: "asc" | "desc" }[];
  limit?: number;
  /** Aggregations; with groupBy, one result row per group. */
  aggs?: { fn: "count" | "min" | "max"; field?: string; as?: string }[];
  groupBy?: string;
  /** Restrict to objects on one page (Download's self-query shape). */
  page?: { ns: string; slug: string };
}

export interface QueryRow {
  page: { ns: string; slug: string; title: string; displayTitle: string | null };
  component: string;
  data: Record<string, unknown>;
}

export interface QueryRowsResult {
  kind: "rows";
  rows: QueryRow[];
  truncated: boolean;
}

export interface QueryAggResult {
  kind: "agg";
  rows: Record<string, unknown>[];
}

export type QueryResult = QueryRowsResult | QueryAggResult;

export class CubeQueryError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "CubeQueryError";
    this.field = field;
  }
}

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 5000;

const PSEUDO_FIELDS: Record<string, { expr: string; sortType: "text" | "date" }> = {
  _page_title: { expr: "p.title", sortType: "text" },
  _page_slug: { expr: "p.slug", sortType: "text" },
  _created: { expr: "p.created_at", sortType: "date" },
  _modified: { expr: "p.updated_at", sortType: "date" },
};

interface Compiled {
  text: string;
  values: unknown[];
  limit: number;
  isAgg: boolean;
}

export interface CompileOptions {
  /** Include moderator-visibility pages (host passes for privileged views). */
  includeHidden?: boolean;
}

class ParamSink {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

export function compileQuery(registry: Registry, q: ObjectQuery, opts: CompileOptions = {}): Compiled {
  const targets = Array.isArray(q.from) ? q.from : [q.from];
  if (targets.length === 0) throw new CubeQueryError("query needs at least one component in `from`");
  const fields = new Map<string, QueryableField>();
  for (const t of targets) {
    if (!registry.has(t)) throw new CubeQueryError(`unknown component: ${t}`);
    for (const [key, f] of registry.fields(t)) {
      if (!fields.has(key)) fields.set(key, f);
    }
  }

  const params = new ParamSink();
  const conds: string[] = [
    `o.component = ANY(${params.add(targets)})`,
    `p.deleted_at IS NULL`,
    `NOT p.is_redirect`,
  ];
  if (!opts.includeHidden) conds.push(`p.visibility = 'public'`);
  if (q.page) {
    conds.push(`p.ns = ${params.add(q.page.ns)}`, `p.slug = ${params.add(q.page.slug)}`);
  }
  if (q.where) conds.push(compileWhere(q.where, fields, params));

  const resolveField = (name: string, forSort: boolean): { expr: string; sortType: string } => {
    const pseudo = PSEUDO_FIELDS[name];
    if (pseudo) return pseudo;
    const f = fields.get(name);
    if (!f) {
      throw new CubeQueryError(
        `unknown field "${name}" (valid: ${[...fields.keys()].sort().join(", ") || "none"})`,
        name,
      );
    }
    return { expr: typedExpr(f), sortType: f.sortType };
  };

  const isAgg = (q.aggs?.length ?? 0) > 0;
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  if (isAgg) {
    const selects: string[] = [];
    if (q.groupBy) {
      selects.push(`${resolveField(q.groupBy, false).expr} AS group_key`);
    }
    for (const agg of q.aggs!) {
      const alias = safeAlias(agg.as ?? `${agg.fn}${agg.field ? `_${agg.field}` : ""}`);
      if (agg.fn === "count") {
        selects.push(`count(*)::bigint AS ${alias}`);
      } else {
        if (!agg.field) throw new CubeQueryError(`${agg.fn} needs a field`);
        selects.push(`${agg.fn}(${resolveField(agg.field, false).expr}) AS ${alias}`);
      }
    }
    const group = q.groupBy ? ` GROUP BY 1 ORDER BY 1` : "";
    return {
      text:
        `SELECT ${selects.join(", ")} FROM cube_page_object o ` +
        `JOIN cube_page p ON p.id = o.page_id WHERE ${conds.join(" AND ")}${group}` +
        (q.groupBy ? ` LIMIT ${params.add(limit)}` : ""),
      values: params.values,
      limit,
      isAgg: true,
    };
  }

  const dataExpr =
    q.select && q.select.length > 0
      ? `jsonb_build_object(${q.select
          .map((k) => {
            resolveField(k, false); // validates
            return `'${k.replace(/'/g, "''")}', o.data->'${k.replace(/'/g, "''")}'`;
          })
          .join(", ")})`
      : "o.data";

  let orderBy = "";
  if (q.sort && q.sort.length > 0) {
    const parts = q.sort.map((s) => {
      const { expr } = resolveField(s.field, true);
      const dir = s.dir === "desc" ? "DESC" : "ASC";
      return `${expr} ${dir} NULLS LAST`;
    });
    orderBy = ` ORDER BY ${parts.join(", ")}, p.slug ASC`;
  } else {
    orderBy = ` ORDER BY p.slug ASC, o.ordinal ASC`;
  }

  return {
    text:
      `SELECT p.ns, p.slug, p.title, p.display_title, o.component, ${dataExpr} AS data ` +
      `FROM cube_page_object o JOIN cube_page p ON p.id = o.page_id ` +
      `WHERE ${conds.join(" AND ")}${orderBy} LIMIT ${params.add(limit + 1)}`,
    values: params.values,
    limit,
    isAgg: false,
  };
}

function typedExpr(f: QueryableField): string {
  const key = f.key.replace(/'/g, "''");
  if (f.sortType === "numeric") return `cube_num(o.data->>'${key}')`;
  if (f.sortType === "date") return `cube_date(o.data->>'${key}')`;
  return `(o.data->>'${key}')`;
}

function textExpr(f: QueryableField): string {
  return `(o.data->>'${f.key.replace(/'/g, "''")}')`;
}

function safeAlias(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `agg_${cleaned}`;
}

function compileWhere(where: Where, fields: Map<string, QueryableField>, params: ParamSink): string {
  if ("and" in where && Array.isArray(where.and)) {
    return `(${(where.and as Where[]).map((w) => compileWhere(w, fields, params)).join(" AND ")})`;
  }
  if ("or" in where && Array.isArray(where.or)) {
    return `(${(where.or as Where[]).map((w) => compileWhere(w, fields, params)).join(" OR ")})`;
  }
  if ("not" in where && typeof where.not === "object" && where.not !== null && !isScalarOrOps(where.not)) {
    return `NOT (${compileWhere(where.not as Where, fields, params)})`;
  }

  const conds: string[] = [];
  for (const [name, raw] of Object.entries(where)) {
    const f = fields.get(name);
    if (!f) {
      throw new CubeQueryError(
        `unknown field "${name}" (valid: ${[...fields.keys()].sort().join(", ") || "none"})`,
        name,
      );
    }
    const ops: WhereOps =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as WhereOps) : { eq: raw as WhereScalar };

    for (const [op, value] of Object.entries(ops)) {
      conds.push(compileOp(f, op as keyof WhereOps, value, params));
    }
  }
  if (conds.length === 0) throw new CubeQueryError("empty where clause");
  return `(${conds.join(" AND ")})`;
}

function isScalarOrOps(v: unknown): boolean {
  return typeof v !== "object" || v === null;
}

function compileOp(f: QueryableField, op: keyof WhereOps, value: unknown, params: ParamSink): string {
  const key = f.key.replace(/'/g, "''");
  // Perf-spike finding: partial indexes are declared `WHERE data ? 'key'`, and
  // the planner cannot prove that from `data->>'key' = x` alone (270x seq-scan
  // penalty). Every positive-match operator therefore also emits the ? clause.
  const has = `o.data ? '${key}'`;
  switch (op) {
    case "eq":
      if (f.multi) {
        // Array membership: data->'key' ? 'value'
        return `o.data->'${key}' ? ${params.add(String(value))}`;
      }
      return `(${has} AND ${textExpr(f)} = ${params.add(scalarText(value))})`;
    case "ne":
      if (f.multi) return `NOT (o.data->'${key}' ? ${params.add(String(value))})`;
      return `${textExpr(f)} IS DISTINCT FROM ${params.add(scalarText(value))}`;
    case "in": {
      if (!Array.isArray(value)) throw new CubeQueryError(`"in" needs an array for ${f.key}`);
      const arr = value.map(scalarText);
      if (f.multi) return `o.data->'${key}' ?| ${params.add(arr)}`;
      return `(${has} AND ${textExpr(f)} = ANY(${params.add(arr)}))`;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const sym = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
      if (f.sortType === "numeric") {
        return `(${has} AND ${typedExpr(f)} ${sym} ${params.add(Number(value))}::numeric)`;
      }
      if (f.sortType === "date") {
        return `(${has} AND ${typedExpr(f)} ${sym} cube_date(${params.add(String(value))}))`;
      }
      return `(${has} AND ${textExpr(f)} ${sym} ${params.add(scalarText(value))})`;
    }
    case "like": {
      if (f.multi) throw new CubeQueryError(`"like" is not supported on multi-value field ${f.key}`);
      if (typeof value !== "string") throw new CubeQueryError(`"like" needs a string for ${f.key}`);
      const pattern = value.replace(/([%_\\])/g, "\\$1").replace(/\*/g, "%");
      return `(${has} AND ${textExpr(f)} ILIKE ${params.add(pattern)})`;
    }
    case "exists":
      return value ? has : `NOT (${has})`;
    default:
      throw new CubeQueryError(`unknown operator "${op}" on ${f.key}`);
  }
}

function scalarText(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/* ---- execution ----------------------------------------------------------- */

export async function runQuery(
  pool: Pool,
  registry: Registry,
  q: ObjectQuery,
  opts: CompileOptions = {},
): Promise<QueryResult> {
  const compiled = compileQuery(registry, q, opts);
  const res = await pool.query(compiled.text, compiled.values);

  if (compiled.isAgg) {
    return { kind: "agg", rows: res.rows };
  }

  const truncated = res.rows.length > compiled.limit;
  const rows = (truncated ? res.rows.slice(0, compiled.limit) : res.rows).map((r) => ({
    page: { ns: r.ns, slug: r.slug, title: r.title, displayTitle: r.display_title },
    component: r.component,
    data: r.data as Record<string, unknown>,
  }));
  return { kind: "rows", rows, truncated };
}
