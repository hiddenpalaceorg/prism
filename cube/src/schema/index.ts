/**
 * The component schema system: the spine of cube.
 *
 * One ComponentSpec drives five consumers: the renderer, the save-time
 * validator, editor node generation, structured-data extraction, and API/MCP
 * introspection. Specs are isomorphic and JSON-safe apart from the pure
 * validate/derive/queries functions; React bindings attach separately
 * (see cube/react) so the RSC/client boundary stays structural.
 */

export type AttrType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "markdown"
  | "media"
  | "page"
  | "json";

export interface AttrQueryableSpec {
  /** JSONB key in cube_page_object.data. Defaults to snake_case of the attr name. */
  key?: string;
  /** Gets a dedicated expression index; equality on it also drives cache filter keys. */
  indexed?: boolean;
  /** How sorts/ranges cast the value. Defaults by attr type (date -> date, number -> numeric). */
  sortType?: "text" | "numeric" | "date";
}

export type SuggestSource =
  | { kind: "objectValues"; component: string; field: string }
  | { kind: "page"; ns?: string }
  | { kind: "media"; mime?: string };

export interface AttrEditorSpec {
  control?: "text" | "textarea" | "combobox" | "checkbox" | "date" | "media" | "page" | "hidden";
  suggest?: SuggestSource;
  label?: string;
  help?: string;
}

export interface ValidateCtx {
  page: PageRef;
}

export interface AttrSpec {
  type: AttrType;
  required?: boolean;
  default?: unknown;
  /** Allowed values, for type "enum". */
  values?: readonly string[];
  /** Accepts an array (JSON attr) or comma-separated string; normalizes to array. */
  multi?: boolean;
  /** Marks this component as a data component; extracted into cube_page_object. */
  queryable?: boolean | AttrQueryableSpec;
  /** Value is folded into the page's search document. */
  searchable?: boolean;
  editor?: AttrEditorSpec;
  /** Extra per-value check; return a message to reject. */
  validate?: (value: unknown, ctx: ValidateCtx) => string | null;
}

export interface PageRef {
  ns: string;
  slug: string;
  title: string;
}

export interface DeriveResult {
  /** Extra fields merged into the extracted object (e.g. sort_date fallback chains). */
  fields?: Record<string, unknown>;
  /** Derived categories, e.g. "Sega Mega Drive prototypes". */
  categories?: string[];
  displayTitle?: string;
  /** Tracking-category analogs, e.g. "Missing title screenshots". */
  warnings?: string[];
}

export interface SchemaError {
  message: string;
  attr?: string;
}

export interface QueryDep {
  component: string;
  /** Fine-grained invalidation key, e.g. "game=Sonic the Hedgehog 2". Omit for component-wide. */
  filterKey?: string | null;
}

export type ChildrenPolicy = "none" | "markdown" | "json" | readonly string[];

export interface ComponentEditorSpec {
  icon?: string;
  description?: string;
  keywords?: string[];
  preview?: "view" | "html" | "card";
}

export interface ComponentSpec<A extends Record<string, AttrSpec> = Record<string, AttrSpec>> {
  /** JSX tag name; must be Capitalized. */
  name: string;
  placement: "block" | "inline";
  /** What may appear between the tags. Default "none" (self-closing only). */
  children?: ChildrenPolicy;
  attrs: A;
  description?: string;
  // Method syntax below is deliberate: it keeps ComponentSpec<Specific>
  // assignable to ComponentSpec (TS method bivariance), which the registry
  // and built-in component lists rely on.
  /** Cross-attr validation, runs after per-attr checks pass. */
  validate?(attrs: AttrValues<A>, ctx: ValidateCtx): SchemaError[];
  /** Pure, save-time: derived fields/categories/display title/warnings. */
  derive?(attrs: AttrValues<A>, ctx: ValidateCtx): DeriveResult;
  /**
   * Object queries this component's RENDERER performs (beyond its own attrs),
   * so saves to those components invalidate pages containing this one.
   * E.g. GameNav declares Prototype/Video/Demo/Assets deps keyed by game.
   */
  queries?(attrs: AttrValues<A>): QueryDep[];
  editor?: ComponentEditorSpec;
}

/* ---- attr value typing ------------------------------------------------- */

type BaseValue<S extends AttrSpec> = S["type"] extends "number"
  ? number
  : S["type"] extends "boolean"
    ? boolean
    : S["type"] extends "json"
      ? unknown
      : string;

type WithMulti<S extends AttrSpec> = S["multi"] extends true ? BaseValue<S>[] : BaseValue<S>;

type IsRequired<S extends AttrSpec> = S["required"] extends true ? true : false;

// The `string extends keyof A` branch keeps the type-erased instantiation
// (ComponentSpec<Record<string, AttrSpec>>) supertype-compatible with every
// specific spec: without it, mixed attr value types fail both variance
// directions and no ComponentSpec<Specific> is assignable to ComponentSpec.
export type AttrValues<A extends Record<string, AttrSpec>> = string extends keyof A
  ? Record<string, unknown>
  : {
      [K in keyof A as IsRequired<A[K]> extends true ? K : never]: WithMulti<A[K]>;
    } & {
      [K in keyof A as IsRequired<A[K]> extends true ? never : K]?: WithMulti<A[K]>;
    };

/* ---- definition + registry --------------------------------------------- */

const NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
const ATTR_RE = /^[a-z][A-Za-z0-9]*$/;

export function defineComponent<A extends Record<string, AttrSpec>>(
  spec: ComponentSpec<A>,
): ComponentSpec<A> {
  if (!NAME_RE.test(spec.name)) {
    throw new Error(`component name must be CapitalizedAlphanumeric: ${JSON.stringify(spec.name)}`);
  }
  for (const [attr, a] of Object.entries(spec.attrs)) {
    if (!ATTR_RE.test(attr)) {
      throw new Error(`${spec.name}: attr name must be camelCase alphanumeric: ${JSON.stringify(attr)}`);
    }
    if (a.type === "enum" && (!a.values || a.values.length === 0)) {
      throw new Error(`${spec.name}.${attr}: enum attr needs values`);
    }
    if (a.default !== undefined && a.required) {
      throw new Error(`${spec.name}.${attr}: required attr cannot have a default`);
    }
  }
  return spec;
}

export function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export interface QueryableField {
  /** JSONB key in object data. */
  key: string;
  attr: string;
  type: AttrType;
  multi: boolean;
  indexed: boolean;
  sortType: "text" | "numeric" | "date";
}

function defaultSortType(t: AttrType): "text" | "numeric" | "date" {
  if (t === "number") return "numeric";
  if (t === "date") return "date";
  return "text";
}

export class Registry {
  private byName = new Map<string, ComponentSpec>();
  private queryable = new Map<string, Map<string, QueryableField>>();

  constructor(specs: ComponentSpec[]) {
    for (const spec of specs) {
      if (this.byName.has(spec.name)) throw new Error(`duplicate component: ${spec.name}`);
      this.byName.set(spec.name, spec);
      const fields = new Map<string, QueryableField>();
      for (const [attr, a] of Object.entries(spec.attrs)) {
        if (!a.queryable) continue;
        const q = a.queryable === true ? {} : a.queryable;
        const key = q.key ?? snakeCase(attr);
        fields.set(key, {
          key,
          attr,
          type: a.type,
          multi: a.multi === true,
          indexed: q.indexed === true,
          sortType: q.sortType ?? defaultSortType(a.type),
        });
      }
      this.queryable.set(spec.name, fields);
    }
  }

  get(name: string): ComponentSpec | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  all(): ComponentSpec[] {
    return [...this.byName.values()];
  }

  /** Queryable fields (data keys) for one component. */
  fields(component: string): Map<string, QueryableField> {
    return this.queryable.get(component) ?? new Map();
  }

  isDataComponent(name: string): boolean {
    return (this.queryable.get(name)?.size ?? 0) > 0;
  }
}

export function createRegistry(specs: ComponentSpec[]): Registry {
  return new Registry(specs);
}

/* ---- attr value normalization ------------------------------------------ */

const PARTIAL_DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

export interface NormalizedAttrs {
  values: Record<string, unknown>;
  errors: SchemaError[];
}

function normalizeScalar(spec: AttrSpec, raw: unknown, attr: string): { value?: unknown; error?: string } {
  switch (spec.type) {
    case "string":
    case "markdown":
    case "media":
    case "page":
      if (typeof raw !== "string") return { error: `${attr} must be a string` };
      return { value: raw };
    case "enum":
      if (typeof raw !== "string") return { error: `${attr} must be a string` };
      if (!spec.values!.includes(raw)) {
        return { error: `${attr} must be one of: ${spec.values!.join(", ")}` };
      }
      return { value: raw };
    case "date": {
      if (typeof raw !== "string") return { error: `${attr} must be a date string` };
      const trimmed = raw.trim();
      if (!PARTIAL_DATE_RE.test(trimmed)) {
        return { error: `${attr} must be an ISO date (YYYY, YYYY-MM, or YYYY-MM-DD)` };
      }
      // Calendar-validate: cube_date() in Postgres uses make_date, which
      // throws on impossible dates: they must never reach the database.
      const [y, m, d] = trimmed.split("-").map(Number);
      if (m !== undefined && (m < 1 || m > 12)) return { error: `${attr}: month out of range` };
      if (d !== undefined) {
        const dt = new Date(Date.UTC(y!, m! - 1, d));
        if (dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
          return { error: `${attr}: not a real calendar date` };
        }
      }
      return { value: trimmed };
    }
    case "number": {
      if (typeof raw === "number") {
        if (!Number.isFinite(raw)) return { error: `${attr} must be a finite number` };
        return { value: raw };
      }
      if (typeof raw === "string" && NUMBER_RE.test(raw.trim())) return { value: Number(raw.trim()) };
      return { error: `${attr} must be a number` };
    }
    case "boolean":
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return { error: `${attr} must be true or false` };
    case "json":
      return { value: raw };
  }
}

/**
 * Validate and normalize raw attr values (strings or JSON from the tag codec)
 * against a component spec. Unknown attrs are reported, defaults applied.
 */
export function normalizeAttrs(
  spec: ComponentSpec,
  raw: Record<string, unknown>,
  ctx: ValidateCtx,
): NormalizedAttrs {
  const values: Record<string, unknown> = {};
  const errors: SchemaError[] = [];

  for (const key of Object.keys(raw)) {
    if (!(key in spec.attrs)) {
      errors.push({ attr: key, message: `<${spec.name}> has no attribute "${key}"` });
    }
  }

  for (const [attr, a] of Object.entries(spec.attrs)) {
    let v = raw[attr];
    if (v === undefined || v === null) {
      if (a.required) {
        errors.push({ attr, message: `<${spec.name}> requires attribute "${attr}"` });
      } else if (a.default !== undefined) {
        values[attr] = a.default;
      }
      continue;
    }
    if (a.multi) {
      const parts = Array.isArray(v)
        ? v
        : typeof v === "string"
          ? v.split(",").map((s) => s.trim()).filter((s) => s !== "")
          : null;
      if (parts === null) {
        errors.push({ attr, message: `${attr} must be a list or comma-separated string` });
        continue;
      }
      const out: unknown[] = [];
      let bad = false;
      for (const part of parts) {
        const r = normalizeScalar(a, part, attr);
        if (r.error) {
          errors.push({ attr, message: r.error });
          bad = true;
          break;
        }
        out.push(r.value);
      }
      if (!bad) values[attr] = out;
    } else {
      const r = normalizeScalar(a, v, attr);
      if (r.error) {
        errors.push({ attr, message: r.error });
        continue;
      }
      v = r.value;
      const custom = a.validate?.(v, ctx);
      if (custom) {
        errors.push({ attr, message: custom });
        continue;
      }
      values[attr] = v;
    }
  }

  if (errors.length === 0 && spec.validate) {
    errors.push(...spec.validate(values as never, ctx));
  }

  return { values, errors };
}

/* ---- introspection (API/MCP consumer) ----------------------------------- */

export interface ComponentSchemaJson {
  name: string;
  placement: "block" | "inline";
  children: "none" | "markdown" | "json" | string[];
  description?: string;
  attrs: Record<
    string,
    {
      type: AttrType;
      required?: boolean;
      default?: unknown;
      values?: string[];
      multi?: boolean;
      queryable?: { key: string; indexed: boolean; sortType: string };
      searchable?: boolean;
    }
  >;
}

export function toSchemaJson(registry: Registry): ComponentSchemaJson[] {
  return registry.all().map((spec) => {
    const fields = registry.fields(spec.name);
    const attrs: ComponentSchemaJson["attrs"] = {};
    for (const [attr, a] of Object.entries(spec.attrs)) {
      const field = [...fields.values()].find((f) => f.attr === attr);
      attrs[attr] = {
        type: a.type,
        ...(a.required && { required: true }),
        ...(a.default !== undefined && { default: a.default }),
        ...(a.values && { values: [...a.values] }),
        ...(a.multi && { multi: true }),
        ...(field && {
          queryable: { key: field.key, indexed: field.indexed, sortType: field.sortType },
        }),
        ...(a.searchable && { searchable: true }),
      };
    }
    return {
      name: spec.name,
      placement: spec.placement,
      children: Array.isArray(spec.children) ? [...spec.children] : ((spec.children ?? "none") as never),
      ...(spec.description && { description: spec.description }),
      attrs,
    };
  });
}
