/**
 * Hidden Palace template mapping tests. The mapping lives with the site
 * components in web/src/cube/mapping.ts; MapCtx is stubbed here (warnings
 * collected, parseDate a fixed table, parseCalls a tiny brace splitter).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AskQuery, MapCtx, TemplateCall, WarningCode } from "../src/import/mediawiki/types";
import { hpMapping, mapAsk } from "../../web/src/cube/mapping";

// ---------------------------------------------------------------------------
// MapCtx stub

const DATES: Record<string, string> = {
  "Sep 29, 1992": "1992-09-29",
  "Nov 21, 1992": "1992-11-21",
  "Nov 24, 1992": "1992-11-24",
  "1992": "1992",
};

/** Balanced-brace splitter, good enough for the nested fixtures used here. */
function tinyParseCalls(wikitext: string): Array<string | TemplateCall> {
  const out: Array<string | TemplateCall> = [];
  let i = 0;
  let textStart = 0;
  while (i < wikitext.length) {
    if (wikitext.startsWith("{{", i)) {
      let depth = 1;
      let j = i + 2;
      while (j < wikitext.length && depth > 0) {
        if (wikitext.startsWith("{{", j)) (depth++, (j += 2));
        else if (wikitext.startsWith("}}", j)) (depth--, (j += 2));
        else j++;
      }
      if (depth !== 0) break; // unbalanced: rest is text
      if (i > textStart) out.push(wikitext.slice(textStart, i));
      out.push(parseCall(wikitext.slice(i + 2, j - 2)));
      i = j;
      textStart = j;
    } else {
      i++;
    }
  }
  if (textStart < wikitext.length) out.push(wikitext.slice(textStart));
  return out;
}

function parseCall(inner: string): TemplateCall {
  const segs: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner.startsWith("{{", i)) (depth++, i++);
    else if (inner.startsWith("}}", i)) (depth--, i++);
    else if (inner[i] === "|" && depth === 0) {
      segs.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  segs.push(inner.slice(start));
  const rawName = (segs.shift() ?? "").trim();
  const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
  const params: Record<string, string> = {};
  let pos = 0;
  for (const seg of segs) {
    const eq = seg.indexOf("=");
    if (eq > 0 && !seg.slice(0, eq).includes("{{")) {
      // Parsoid delivers named param values whitespace-trimmed.
      params[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
    } else {
      params[String(++pos)] = seg; // positional: untrimmed, like Parsoid
    }
  }
  return { kind: "template", name, params };
}

interface Warned {
  code: WarningCode;
  message: string;
}

function makeCtx(): { ctx: MapCtx; warnings: Warned[] } {
  const warnings: Warned[] = [];
  const ctx: MapCtx = {
    pageTitle: "Test Page",
    warn(code, message) {
      warnings.push({ code, message });
    },
    parseCalls: tinyParseCalls,
    parseDate: (text) => DATES[text.trim()] ?? null,
  };
  return { ctx, warnings };
}

function tpl(name: string, params: Record<string, string> = {}): TemplateCall {
  return { kind: "template", name, params };
}

function fn(name: string, params: Record<string, string> = {}): TemplateCall {
  return { kind: "function", name, params };
}

function componentOf(result: ReturnType<typeof hpMapping.map>) {
  assert.equal(result.kind, "component");
  return result as Extract<typeof result, { kind: "component" }>;
}

// ---------------------------------------------------------------------------
// Prototype

// Verbatim params from spikes/fixtures/parsoid/sonic2_nick_arcade.wiki.
const SONIC2_PARAMS: Record<string, string> = {
  titlescreen: "S2NA_Title.png",
  builddate: "1992",
  status: "Released",
  dumper: "drx",
  origin_type: "Encased Mega Drive EPROM cartridge ([[171-5694-01]])",
  origin_board: "171-5694-01",
  origin_labels: "Holographic case label, EPROMs labeled Sonic 0, 1, 2 and 3",
  origin_eproms: "4x 27c020 (1MB)",
  origin_ownership: "Unknown (1992-2006),<br>[[drx]] (2006-present)",
  game: "Sonic the Hedgehog 2",
  system: "Sega Mega Drive",
  genre: "Platform",
  final_builddate: "Sep 29, 1992 10:33:00",
  release_date: "{{RegionDate|JP|Nov 21, 1992}} {{RegionDate|US|Nov 24, 1992}} {{RegionDate|EU|Nov 24, 1992}}",
  unreleased: "No",
  sortnumber: "1",
};

test("Prototype: the full Sonic 2 Nick Arcade call maps to typed attrs", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(hpMapping.map(tpl("Prototype", SONIC2_PARAMS), ctx));
  assert.equal(result.name, "Prototype");
  assert.deepEqual(result.attrs, {
    titleScreen: "S2NA_Title.png",
    buildDate: "1992",
    status: "Released",
    dumpedBy: ["drx"],
    originType: "Encased Mega Drive EPROM cartridge ([[171-5694-01]])",
    originBoard: "171-5694-01",
    originLabels: "Holographic case label, EPROMs labeled Sonic 0, 1, 2 and 3",
    originEproms: "4x 27c020 (1MB)",
    originOwnership: "Unknown (1992-2006),<br>[[drx]] (2006-present)",
    game: "Sonic the Hedgehog 2",
    system: "Sega Mega Drive",
    genre: "Platform",
    finalBuildDate: "Sep 29, 1992 10:33:00",
    releaseDate: [
      { region: "JP", date: "1992-11-21" },
      { region: "US", date: "1992-11-24" },
      { region: "EU", date: "1992-11-24" },
    ],
    unreleased: false,
    sortNumber: 1,
  });
  assert.deepEqual(warnings, []);
});

test("Prototype: {{{...}}} passthrough params drop silently (origin_files bug)", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    hpMapping.map(tpl("Prototype", { game: "X", origin_files: "{{{origin_files}}}" }), ctx),
  );
  assert.deepEqual(result.attrs, { game: "X" });
  assert.deepEqual(warnings, []);
});

test("Prototype: dumper comma-splits, aliases and empties handled", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    hpMapping.map(
      tpl("Prototype", { game: "X", dumpedby: "drx, Kat , ", "build name": "Alpha 3", status: "  " }),
      ctx,
    ),
  );
  assert.deepEqual(result.attrs, { game: "X", dumpedBy: ["drx", "Kat"], buildName: "Alpha 3" });
  assert.deepEqual(warnings, []);
});

test("Prototype: name is the game fallback; unknown params warn and drop", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(hpMapping.map(tpl("Prototype", { name: "Lost Game", bogus: "y" }), ctx));
  assert.deepEqual(result.attrs, { game: "Lost Game" });
  assert.deepEqual(
    warnings.map((w) => w.code),
    ["PARAM_UNKNOWN"],
  );
});

test("Prototype: unparseable date-typed attr drops with DATE_UNPARSEABLE", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    hpMapping.map(tpl("Prototype", { game: "X", builddate: "sometime in fall" }), ctx),
  );
  assert.equal(result.attrs.buildDate, undefined);
  assert.deepEqual(
    warnings.map((w) => w.code),
    ["DATE_UNPARSEABLE"],
  );
});

test("Prototype: release_date keeps raw dates and prose segments structurally", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    hpMapping.map(
      tpl("Prototype", { game: "X", release_date: "{{RegionDate|JP|Late 1993}} cancelled elsewhere" }),
      ctx,
    ),
  );
  assert.deepEqual(result.attrs.releaseDate, [
    { region: "JP", date: "Late 1993" },
    { region: "", date: "cancelled elsewhere" },
  ]);
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// Board / Video

test("Board maps hardware params, comma-split chips", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    hpMapping.map(
      tpl("Board", {
        hardware_id: "171-5694-01",
        hardware_type: "EPROM cartridge board",
        hardware_date: "1992",
        chips: "27c020, 27c020, 27c020, 27c020",
        photo: "S2b_cart_front.jpg",
        system: "Sega Mega Drive",
      }),
      ctx,
    ),
  );
  assert.equal(result.name, "Board");
  assert.deepEqual(result.attrs, {
    hardwareId: "171-5694-01",
    hardwareType: "EPROM cartridge board",
    hardwareDate: "1992",
    chips: ["27c020", "27c020", "27c020", "27c020"],
    photo: "S2b_cart_front.jpg",
    system: "Sega Mega Drive",
  });
  assert.deepEqual(warnings, []);
});

test("Video maps date alias and semicolon-splits multi game", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    hpMapping.map(
      tpl("Video", {
        date: "1992",
        status: "Released",
        transferredby: "drx, Kat",
        game: "Sonic the Hedgehog 2; Sonic the Hedgehog",
        system: "Sega Mega Drive",
      }),
      ctx,
    ),
  );
  assert.equal(result.name, "Video");
  assert.deepEqual(result.attrs, {
    videoDate: "1992",
    videoStatus: "Released",
    transferredBy: ["drx", "Kat"],
    game: ["Sonic the Hedgehog 2", "Sonic the Hedgehog"],
    system: "Sega Mega Drive",
  });
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// Download

test("Download drops the {{PAGENAME}} title idiom", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    hpMapping.map(
      tpl("Download", { file: "Sonic_The_Hedgehog_2_(Early_prototype).rar", title: "{{PAGENAME}}" }),
      ctx,
    ),
  );
  assert.deepEqual(result.attrs, { file: "Sonic_The_Hedgehog_2_(Early_prototype).rar" });
  assert.deepEqual(warnings, []);
});

test("Download extracts external URLs from bracketed wikitext", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    hpMapping.map(
      tpl("Download", {
        file: "X.rar",
        title: "A real title",
        external: "[https://example.com/a.zip Mirror A] https://b.example.org/c.7z",
      }),
      ctx,
    ),
  );
  assert.deepEqual(result.attrs, {
    file: "X.rar",
    title: "A real title",
    external: ["https://example.com/a.zip", "https://b.example.org/c.7z"],
  });
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// filelist

test("filelist serializes a FileList/FileEntry markdown block", () => {
  const { ctx, warnings } = makeCtx();
  // Verbatim from the Sonic 2 fixture: entries nested in the one positional param.
  const inner =
    "\n\n{{filelistentry | 1 |filename= Sonic The Hedgehog 2 (Early prototype) (dumped by hidden-palace.org).bin |type= Mega Drive ROM Image |size= 1048576\n" +
    "|crc32= 39faaa70|md5= a460bf633579a80eebbc09d6809e1b09|sha1= 5b51b4d98cb4a7a38157dc4ab9462164dd224bfd }}\n";
  const result = hpMapping.map(tpl("Filelist", { "1": inner }), ctx);
  assert.equal(result.kind, "markdown");
  const md = (result as { kind: "markdown"; markdown: string }).markdown;
  assert.ok(md.startsWith("<FileList>\n"));
  assert.ok(md.endsWith("\n</FileList>"));
  // Schema attr order: n before filename; numbers as brace values.
  assert.ok(
    md.includes(
      '<FileEntry n={1} filename="Sonic The Hedgehog 2 (Early prototype) (dumped by hidden-palace.org).bin"',
    ),
  );
  assert.ok(md.includes('type="Mega Drive ROM Image"'));
  assert.ok(md.includes("size={1048576}"));
  assert.ok(md.includes('crc32="39faaa70"'));
  assert.ok(md.includes('sha1="5b51b4d98cb4a7a38157dc4ab9462164dd224bfd"'));
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// Video embed / inline templates / footer

test("Video embed extracts the YouTube id from URL forms and bare ids", () => {
  const { ctx } = makeCtx();
  for (const link of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "dQw4w9WgXcQ",
  ]) {
    const result = componentOf(hpMapping.map(tpl("Video embed", { youtubelink: link }), ctx));
    assert.equal(result.name, "YouTube");
    assert.deepEqual(result.attrs, { id: "dQw4w9WgXcQ" });
  }
});

test("top-level RegionDate and Tcrf link map to inline components", () => {
  const { ctx } = makeCtx();
  const rd = componentOf(hpMapping.map(tpl("RegionDate", { "1": "JP", "2": " Nov 21, 1992 " }), ctx));
  assert.equal(rd.name, "RegionDate");
  assert.equal(rd.placement, "inline");
  assert.deepEqual(rd.attrs, { region: "JP", date: "Nov 21, 1992" });

  const tcrf = componentOf(
    hpMapping.map(tpl("Tcrf link", { "1": " Proto:Sonic the Hedgehog 2 (Genesis)/Nick Arcade Prototype" }), ctx),
  );
  assert.equal(tcrf.name, "TcrfLink");
  assert.equal(tcrf.placement, "block"); // standalone panel on real pages
  assert.deepEqual(tcrf.attrs, { page: "Proto:Sonic the Hedgehog 2 (Genesis)/Nick Arcade Prototype" });
});

test("Prototype Footer unwraps the nested Navbox prototype into GameNav", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    hpMapping.map(tpl("Prototype Footer", { "1": "{{Navbox prototype|Sonic the Hedgehog 2}}" }), ctx),
  );
  assert.equal(result.name, "GameNav");
  assert.deepEqual(result.attrs, { game: "Sonic the Hedgehog 2" });
  assert.deepEqual(warnings, []);

  const direct = componentOf(hpMapping.map(tpl("Navbox prototype", { "1": "Sonic CD" }), ctx));
  assert.equal(direct.name, "GameNav");
  assert.deepEqual(direct.attrs, { game: "Sonic CD" });

  const hw = componentOf(hpMapping.map(tpl("Hardware system", { "1": "Sega Mega Drive" }), ctx));
  assert.equal(hw.name, "HardwareSystem");
  assert.deepEqual(hw.attrs, { system: "Sega Mega Drive" });
});

// ---------------------------------------------------------------------------
// Fallthrough behavior

test("machinery templates and plumbing functions drop silently", () => {
  const { ctx, warnings } = makeCtx();
  for (const name of ["DoNotUploadList", "Imageexists", "Filesize", "System", "Autolink user"]) {
    assert.deepEqual(hpMapping.map(tpl(name), ctx), { kind: "drop" });
  }
  for (const name of ["default_form", "arraydefine", "arrayprint", "regex", "if", "ifexpr", "ifexist", "time", "tag"]) {
    assert.deepEqual(hpMapping.map(fn(name), ctx), { kind: "drop" });
  }
  assert.deepEqual(warnings, []);
});

test("unmapped templates keep expanded HTML with a warning", () => {
  const { ctx, warnings } = makeCtx();
  assert.deepEqual(hpMapping.map(tpl("Some Old Box", { "1": "x" }), ctx), { kind: "keep-html" });
  assert.deepEqual(
    warnings.map((w) => w.code),
    ["UNMAPPED_TEMPLATE"],
  );
});

test("unknown parser functions stay verbatim with a warning", () => {
  const { ctx, warnings } = makeCtx();
  assert.deepEqual(hpMapping.map(fn("vardefine", { "1": "x" }), ctx), { kind: "verbatim" });
  assert.deepEqual(
    warnings.map((w) => w.code),
    ["UNMAPPED_TEMPLATE"],
  );
});

// ---------------------------------------------------------------------------
// mapAsk

function askOf(overrides: Partial<AskQuery>): AskQuery {
  return { conditions: "", printouts: [], extra: {}, ...overrides };
}

test("mapAsk: the Videos list shape becomes a table Query", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    mapAsk(
      askOf({
        conditions: "[[Has article type::Video]]",
        printouts: [
          { property: "Has game", label: "Game" },
          { property: "Has video date", label: "Date" },
          { property: "Has system", label: "System" },
          { property: "Has genre", label: "Genre" },
        ],
        limit: 3000,
      }),
      ctx,
    ),
  );
  assert.equal(result.name, "Query");
  assert.deepEqual(result.attrs, {
    from: "Video",
    select: ["game", "video_date", "system", "genre"],
    headers: ["Game", "Date", "System", "Genre"],
    limit: 3000,
  });
  assert.deepEqual(warnings, []);
});

test("mapAsk: count shape with a property equality condition", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    mapAsk(
      askOf({
        conditions: "[[Has article type::Prototype]] [[Has game::Sonic the Hedgehog 2]]",
        format: "count",
      }),
      ctx,
    ),
  );
  assert.deepEqual(result.attrs, {
    from: "Prototype",
    where: { game: "Sonic the Hedgehog 2" },
    format: "count",
  });
  assert.deepEqual(warnings, []);
});

test("mapAsk: hardware id existence implies from Board; template format maps to render", () => {
  const { ctx, warnings } = makeCtx();
  const exists = componentOf(mapAsk(askOf({ conditions: "[[Has hardware id::+]]" }), ctx));
  assert.deepEqual(exists.attrs, { from: "Board", where: { hardware_id: { exists: true } } });
  assert.equal(warnings.length, 0);

  const lots = componentOf(
    mapAsk(
      askOf({
        conditions: "[[Has article type::Lot]]",
        format: "template",
        template: "Lot item",
        sort: ["Creation date"],
        order: ["desc"],
      }),
      ctx,
    ),
  );
  assert.deepEqual(lots.attrs, {
    from: "Lot",
    format: "render",
    render: "Lot item",
    sort: [{ field: "_created", dir: "desc" }],
  });
  assert.deepEqual(
    warnings.map((w) => w.code),
    ["ASK_UNSUPPORTED"], // the render-must-exist note
  );
});

test("mapAsk: article-type alternation and approximations", () => {
  const { ctx, warnings } = makeCtx();
  const result = componentOf(
    mapAsk(askOf({ conditions: "[[Has article type::Prototype||Disc type]]" }), ctx),
  );
  assert.deepEqual(result.attrs, { from: ["Prototype", "Board"] });
  assert.deepEqual(
    warnings.map((w) => w.code),
    ["ASK_UNSUPPORTED"], // the Disc type approximation
  );
});

test("mapAsk: nothing mappable stays verbatim with a warning", () => {
  const { ctx, warnings } = makeCtx();
  assert.deepEqual(mapAsk(askOf({ conditions: "[[Category:Unreleased games]]" }), ctx), {
    kind: "verbatim",
  });
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.every((w) => w.code === "ASK_UNSUPPORTED"));
});
