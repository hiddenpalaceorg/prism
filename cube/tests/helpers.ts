/** Shared test fixtures: an HP-like component set exercising every schema feature. */

import { builtinComponents } from "../src/builtins";
import { createRegistry, defineComponent } from "../src/schema/index";

export const Prototype = defineComponent({
  name: "Prototype",
  placement: "block",
  attrs: {
    game: { type: "string", required: true, queryable: { indexed: true }, searchable: true },
    system: { type: "string", queryable: { indexed: true } },
    buildDate: { type: "date", queryable: true },
    sortNumber: { type: "number", default: 999999, queryable: true },
    originLot: { type: "page", queryable: { indexed: true } },
    dumpedBy: { type: "string", multi: true, queryable: true },
    unreleased: { type: "boolean", queryable: true },
    status: { type: "enum", values: ["Released", "Unreleased", "Pending"] as const },
    titleScreen: { type: "media" },
  },
  derive: (a) => ({
    fields: { sort_date: a.buildDate ?? "1970" },
    categories: [
      `${a.game} prototypes`,
      ...(a.system ? [`${a.system} prototypes`] : []),
    ],
    ...(a.titleScreen ? {} : { warnings: ["Missing title screenshots"] }),
  }),
});

export const GameNav = defineComponent({
  name: "GameNav",
  placement: "block",
  attrs: {
    game: { type: "string", required: true },
  },
  queries: (a) => [{ component: "Prototype", filterKey: `game=${a.game}` }],
});

export const RegionDate = defineComponent({
  name: "RegionDate",
  placement: "inline",
  attrs: {
    region: { type: "string", required: true },
    date: { type: "string", required: true },
  },
});

export const HexDump = defineComponent({
  name: "HexDump",
  placement: "block",
  children: "json",
  attrs: {},
});

export const FileEntry = defineComponent({
  name: "FileEntry",
  placement: "block",
  attrs: {
    filename: { type: "string", required: true, queryable: true },
    size: { type: "number", queryable: true },
    sha1: { type: "string", queryable: true },
  },
});

export const FileList = defineComponent({
  name: "FileList",
  placement: "block",
  children: ["FileEntry"] as const,
  attrs: {},
});

export const testComponents = [Prototype, GameNav, RegionDate, HexDump, FileList, FileEntry];
export const testRegistry = createRegistry([...builtinComponents, ...testComponents]);

export const testPage = { ns: "main", slug: "Test_Page", title: "Test Page" };
