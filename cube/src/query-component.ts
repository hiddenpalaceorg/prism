/** Bridges <Query> component attrs to the ObjectQuery DSL, including the
 * save-time compile check that gives authors line-accurate query errors. */

import type { Issue } from "./issues";
import { at } from "./issues";
import type { Registry } from "./schema/index";
import { compileQuery, CubeQueryError, type ObjectQuery, type Where } from "./query";
import type { ComponentInstance } from "./validate";

export type QueryAttrs = {
  from: string | string[];
  where?: Where;
  select?: string[];
  sort?: ({ field: string; dir?: "asc" | "desc" } | string)[];
  limit?: number;
  format?: "table" | "ul" | "count" | "earliest" | "latest" | "inline" | "render";
  of?: string;
  render?: string;
  groupBy?: string;
  headers?: string[];
};

/** Build the DSL query a <Query> instance runs, given the page it sits on. */
export function toObjectQuery(
  attrs: Record<string, unknown>,
  page?: { ns: string; slug: string },
): ObjectQuery {
  const a = attrs as unknown as QueryAttrs;
  const format = a.format ?? "table";

  const sort = (a.sort ?? []).map((s) =>
    typeof s === "string"
      ? s.startsWith("-")
        ? { field: s.slice(1), dir: "desc" as const }
        : { field: s, dir: "asc" as const }
      : s,
  );

  const q: ObjectQuery = {
    from: a.from,
    ...(a.where && { where: a.where }),
    ...(a.select && { select: a.select }),
    ...(sort.length > 0 && { sort }),
    ...(a.limit !== undefined && { limit: a.limit }),
    ...(a.groupBy && { groupBy: a.groupBy }),
  };

  if (format === "count") q.aggs = [{ fn: "count", as: "count" }];
  if (format === "earliest") q.aggs = [{ fn: "min", field: requiredOf(a), as: "value" }];
  if (format === "latest") q.aggs = [{ fn: "max", field: requiredOf(a), as: "value" }];
  if (format === "inline") q.limit = a.limit ?? 1;
  if (page) q.page = undefined; // self-page filtering is opt-in via where.page in v2; keep explicit for now

  return q;
}

function requiredOf(a: QueryAttrs): string {
  if (!a.of) throw new CubeQueryError(`format="${a.format}" requires the "of" attribute`);
  return a.of;
}

/** Compile-check every <Query> on a page; returns issues instead of throwing. */
export function checkQueries(registry: Registry, components: ComponentInstance[]): Issue[] {
  const issues: Issue[] = [];
  for (const inst of components) {
    if (inst.name !== "Query") continue;
    try {
      compileQuery(registry, toObjectQuery(inst.attrs));
    } catch (err) {
      if (err instanceof CubeQueryError) {
        issues.push(
          at(
            {
              severity: "error",
              rule: "query",
              message: err.message,
              component: "Query",
              ...(err.field && { attr: err.field }),
            },
            inst.node.position,
          ),
        );
      } else {
        throw err;
      }
    }
  }
  return issues;
}
