import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidElement, type ReactNode } from "react";
import { parseDocument } from "../src/parse";
import { renderAst, type CubeRenderCtx } from "../src/react/index";
import { testPage, testRegistry } from "./helpers";

/** Flatten a React element tree to text + tag markers, resolving async components. */
async function renderToText(node: ReactNode): Promise<string> {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    const parts = await Promise.all(node.map(renderToText));
    return parts.join("");
  }
  if (node instanceof Promise) return renderToText(await node);
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown> & { children?: ReactNode };
    if (typeof node.type === "function") {
      const result = (node.type as (p: unknown) => ReactNode | Promise<ReactNode>)(props);
      return renderToText(await result);
    }
    if (typeof node.type === "symbol" || typeof node.type !== "string") {
      return renderToText(props.children ?? null);
    }
    const attrs = Object.entries(props)
      .filter(([k, v]) => k !== "children" && k !== "key" && (typeof v === "string" || typeof v === "number"))
      .map(([k, v]) => ` ${k}="${String(v)}"`)
      .join("");
    const inner = await renderToText(props.children ?? null);
    return `<${node.type}${attrs}>${inner}</${node.type}>`;
  }
  return "";
}

function ctx(overrides: Partial<CubeRenderCtx> = {}): CubeRenderCtx {
  return {
    registry: testRegistry,
    page: testPage,
    pageHref: (ref) => (ref.ns === "main" ? `/${ref.slug}` : `/${ref.ns}:${ref.slug}`),
    ...overrides,
  };
}

async function render(markdown: string, overrides: Partial<CubeRenderCtx> = {}) {
  const { root, issues } = parseDocument(markdown);
  assert.ok(root, JSON.stringify(issues));
  const page = await renderAst(root!, ctx(overrides));
  return { html: await renderToText(page.node), headings: page.headings };
}

test("markdown basics render", async () => {
  const { html, headings } = await render("# Hello\n\nSome **bold** and `code`.\n");
  assert.match(html, /<h1 id="hello">Hello<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.deepEqual(headings, [{ depth: 1, text: "Hello", id: "hello" }]);
});

test("wiki links: existing, red, labeled, interwiki", async () => {
  const { html } = await render(
    "See [[Existing Page]] and [[Missing|the missing one]] and [[tcrf:Proto:Sonic 2]].\n",
    {
      interwiki: { tcrf: "https://tcrf.net/$1" },
      resolveLinks: async (refs) =>
        new Map(refs.map((r) => [`${r.ns}:${r.slug}`, r.slug === "Existing_Page"])),
    },
  );
  assert.match(html, /<a href="\/Existing_Page">Existing Page<\/a>/);
  assert.match(html, /<a href="\/Missing" className="cube-redlink">the missing one<\/a>/);
  assert.match(html, /<a href="https:\/\/tcrf\.net\/Proto:Sonic_2" className="cube-interwiki">/);
});

test("raw html renders escaped as text, not elements", async () => {
  // Use React's real serializer here: the html value must be a text child
  // (escaped on output), never parsed into elements.
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { root } = parseDocument("<script>alert(1)</script>\n");
  const page = await renderAst(root!, ctx());
  const markup = renderToStaticMarkup(page.node as never);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
});

test("allowed intrinsic tags render; media images resolve", async () => {
  const { html } = await render(
    'Some <b>bold</b> and ![shot](media:S2NA_Title.png) here.\n',
    { resolveMedia: async (names) => new Map(names.map((n) => [n, `https://files.example/${n}`])) },
  );
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<img src="https:\/\/files\.example\/S2NA_Title\.png" alt="shot">/);
});

test("component with host binding: loader data flows to View", async () => {
  const { html } = await render(`<GameNav game="Comix Zone" />\n`, {
    bindings: {
      GameNav: {
        loader: async (attrs) => ({ count: 3, game: attrs.game }),
        View: ({ data }) => {
          const d = data as { count: number; game: string };
          return `NAV(${d.game}:${d.count})`;
        },
      },
    },
  });
  assert.match(html, /NAV\(Comix Zone:3\)/);
});

test("Query default table view renders rows from runQuery", async () => {
  const { html } = await render(
    `<Query from="Prototype" where={{"system": "SNES"}} select={["game", "build_date"]} headers={["Game", "Date"]} />\n`,
    {
      runQuery: async () => ({
        kind: "rows",
        truncated: false,
        rows: [
          {
            page: { ns: "main", slug: "A_(proto)", title: "A (proto)", displayTitle: null },
            component: "Prototype",
            data: { game: "A", build_date: "1995-01" },
          },
        ],
      }),
    },
  );
  assert.match(html, /<th>Game<\/th><th>Date<\/th>/);
  assert.match(html, /<a href="\/A_\(proto\)">A \(proto\)<\/a>/);
  assert.match(html, /<td>1995-01<\/td>/);
});

test("Query count renders inline value", async () => {
  const { html } = await render(`<Query from="Prototype" format="count" />\n`, {
    runQuery: async () => ({ kind: "agg", rows: [{ count: 42 }] }),
  });
  assert.match(html, /<span>42<\/span>/);
});

test("metadata components render nothing", async () => {
  const { html } = await render(`<Category name="X" />\n\ntext\n`);
  assert.doesNotMatch(html, /Category/);
  assert.match(html, /text/);
});

test("unbound site component renders a visible placeholder", async () => {
  const { html } = await render(`<Prototype game="X" />\n`);
  assert.match(html, /<span className="cube-missing-binding">\[Prototype\]<\/span>/);
});

test("gfm table renders with alignment", async () => {
  const { html } = await render("| a | b |\n| :- | -: |\n| 1 | 2 |\n");
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>2<\/td>/);
});
