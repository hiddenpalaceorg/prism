/**
 * Hidden Palace component bindings. Two things are under test: that
 * page-authored json (attrs typed "json", and children: "json" payloads, both
 * of which the core passes through unvalidated) can never throw out of a View,
 * and that imported inline wikitext reaches the infobox as links rather than
 * literal brackets.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentViewProps, CubeRenderCtx } from "cube/react";
import { hpBindings } from "../src/cube/registry";

function render(name: string, props: Partial<ComponentViewProps>): string {
  const View = hpBindings[name]!.View;
  return renderToStaticMarkup(
    (View as (p: ComponentViewProps) => never)({
      attrs: {},
      page: { ns: "main", slug: "T", title: "T" },
      ...props,
    } as ComponentViewProps),
  );
}

/* ---- unvalidated json cannot crash a View -------------------------------- */

test("HexDump renders a well-formed payload", () => {
  const html = render("HexDump", {
    childrenJson: {
      lines: [{ offset: "00000100", bytes: "53 45 47 41", ascii: "SEGA" }],
      annotations: [{ line: 0, start: 0, length: 2, field: "System", value: "Sega" }],
    },
  });
  assert.match(html, /00000100/);
  assert.match(html, /53 45/);
  assert.match(html, /System: Sega/);
});

test("HexDump survives malformed payloads instead of throwing", () => {
  // Each of these used to throw inside a server component and 500 the article.
  const payloads: unknown[] = [
    { lines: [{ offset: "0" }] }, // no `bytes`
    { lines: [{}] },
    { lines: [null, 42, "x"] },
    { lines: [{ offset: {}, bytes: [] }] }, // object where a string is expected
    { lines: [{ bytes: "41" }], annotations: [{ line: "x", start: {}, length: null }] },
    { lines: [] },
    { lines: "not an array" },
    null,
  ];
  for (const childrenJson of payloads) {
    assert.doesNotThrow(
      () => render("HexDump", { childrenJson }),
      `payload ${JSON.stringify(childrenJson)}`,
    );
  }
});

test("Prototype survives non-string releaseDate entries", () => {
  assert.doesNotThrow(() =>
    render("Prototype", {
      attrs: { game: "X", releaseDate: [{ region: {}, date: [] }, null, "str", 7] },
      data: {},
    }),
  );
  const html = render("Prototype", {
    attrs: { game: "X", releaseDate: [{ region: "JP", date: "1992-11-21" }] },
    data: {},
  });
  assert.match(html, /1992-11-21/);
  assert.match(html, /JP/);
});

/* ---- imported inline wikitext ------------------------------------------- */

function ctxWith(existing: string[]): CubeRenderCtx {
  return {
    registry: { get: () => undefined, all: () => [] } as unknown as CubeRenderCtx["registry"],
    page: { ns: "main", slug: "T", title: "T" },
    pageHref: (ref) => `/${ref.slug}`,
    resolveLinks: async (refs) =>
      new Map(refs.map((r) => [`${r.ns}:${r.slug}`, existing.includes(r.slug)])),
  } as CubeRenderCtx;
}

test("Prototype origin fields render wikilinks and <br>, not literal markup", async () => {
  const attrs = {
    game: "Sonic the Hedgehog 2",
    originType: "Encased Mega Drive EPROM cartridge ([[171-5694-01]])",
    originOwnership: "Unknown (1992-2006),<br>[[drx]] (2006-present)",
  };
  const data = await hpBindings.Prototype!.loader!(attrs, ctxWith(["171-5694-01"]));
  const html = render("Prototype", { attrs, data });

  assert.doesNotMatch(html, /\[\[/, "no literal wikilink brackets survive");
  assert.doesNotMatch(html, /&lt;br&gt;/, "no escaped <br> text survives");
  assert.match(html, /<a href="\/171-5694-01"[^>]*>171-5694-01<\/a>/, "board link rendered");
  assert.match(html, /<br\/?>/, "line break rendered as an element");
  // A target with no page of its own still links, marked as a red link.
  assert.match(html, /cube-redlink[^>]*>drx</, "missing target gets the redlink class");
});

test("plain origin fields are left as-is", async () => {
  const attrs = { game: "X", originEproms: "4x 27c020 (1MB)" };
  const data = await hpBindings.Prototype!.loader!(attrs, ctxWith([]));
  assert.deepEqual((data as { rich: Record<string, unknown> }).rich, {});
  assert.match(render("Prototype", { attrs, data }), /4x 27c020 \(1MB\)/);
});

test("Board text renders its wikilinks", async () => {
  const attrs = { hardwareId: "171-5694-01", text: "See [[Sonic the Hedgehog 2|the game]]" };
  const data = await hpBindings.Board!.loader!(attrs, ctxWith(["Sonic_the_Hedgehog_2"]));
  const html = render("Board", { attrs, data });
  assert.match(html, /<a href="\/Sonic_the_Hedgehog_2"[^>]*>the game<\/a>/);
});
