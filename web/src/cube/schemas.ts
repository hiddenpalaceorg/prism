/**
 * Hidden Palace site component schemas for the cube wiki engine.
 * Pure spec definitions (no React): the render bindings live in registry.tsx.
 * Attr lists follow the site design (MW template -> component mapping).
 */

import { defineComponent, type ComponentSpec } from "cube/schema";

export const Prototype = defineComponent({
  name: "Prototype",
  placement: "block",
  description: "Infobox and structured data for a prototype build article",
  attrs: {
    titleScreen: { type: "media" },
    buildDate: { type: "date", queryable: true },
    buildName: { type: "string", queryable: true },
    status: { type: "string", queryable: true },
    datStatus: { type: "string" },
    dumpedBy: { type: "string", multi: true, queryable: true },
    releasedBy: { type: "string", multi: true, queryable: true },
    fileDumpDate: { type: "date", queryable: true },
    fileReleaseDate: { type: "date", queryable: true },
    originType: { type: "string", queryable: true },
    originLot: { type: "page", queryable: { indexed: true } },
    originEproms: { type: "string" },
    originBoard: { type: "page", queryable: { indexed: true } },
    originDiscType: { type: "string" },
    originDevKit: { type: "string" },
    originLabels: { type: "string" },
    originFiles: { type: "string" },
    originDumpMethod: { type: "string" },
    originOwnership: { type: "string" },
    game: { type: "string", required: true, queryable: { indexed: true }, searchable: true },
    system: { type: "string", queryable: { indexed: true } },
    genre: { type: "string", queryable: true },
    finalBuildDate: { type: "string" },
    /** Array of { region, date }. */
    releaseDate: { type: "json" },
    unreleased: { type: "boolean", queryable: true },
    sortNumber: { type: "number", queryable: true, default: 999999 },
    builtAfter: { type: "date", queryable: true },
    newsPage: { type: "string" },
  },
  derive(attrs) {
    const categories = [`${attrs.game} prototypes`];
    if (attrs.system) categories.push(`${attrs.system} prototypes`);
    if (attrs.unreleased) categories.push("Unreleased game prototypes");
    const sortDate = attrs.buildDate ?? attrs.fileReleaseDate ?? "1970";
    return {
      fields: {
        article_type: "Prototype",
        sort_date: sortDate,
        built_after: attrs.builtAfter ?? sortDate,
      },
      categories,
      ...(attrs.titleScreen ? {} : { warnings: ["Missing title screenshots"] }),
    };
  },
});

export const Board = defineComponent({
  name: "Board",
  placement: "block",
  description: "Infobox and structured data for a development board article",
  attrs: {
    hardwareId: { type: "string", required: true, queryable: { indexed: true } },
    hardwareType: { type: "string", queryable: true },
    hardwareDate: { type: "date", queryable: true },
    chips: { type: "string", multi: true },
    text: { type: "string" },
    // Queryable so HardwareSystem tiles can read photo names from object data.
    photo: { type: "media", queryable: true },
    system: { type: "string", queryable: { indexed: true } },
    game: { type: "string" },
  },
  derive() {
    return { fields: { article_type: "Board" } };
  },
  queries(attrs) {
    // "Used in" renderer query: invalidate on Prototype saves for this board.
    return [
      {
        component: "Prototype",
        filterKey: attrs.hardwareId ? `origin_board=${attrs.hardwareId}` : null,
      },
    ];
  },
});

export const Video = defineComponent({
  name: "Video",
  placement: "block",
  description: "Infobox and structured data for a prototype video article",
  attrs: {
    videoDate: { type: "date", queryable: true },
    videoStatus: { type: "string", queryable: true },
    videoMedia: { type: "string" },
    transferredBy: { type: "string", multi: true, queryable: true },
    game: { type: "string", multi: true, queryable: { indexed: true } },
    system: { type: "string", queryable: { indexed: true } },
    genre: { type: "string", queryable: true },
  },
  derive(attrs) {
    return {
      fields: { article_type: "Video" },
      categories: (attrs.game ?? []).map((g) => `${g} videos`),
    };
  },
});

export const Lot = defineComponent({
  name: "Lot",
  placement: "block",
  description: "Header card and structured data for an acquisition lot article",
  attrs: {
    name: { type: "string", required: true, queryable: { indexed: true } },
    acquiredDate: { type: "date", queryable: true },
    description: { type: "string", searchable: true },
  },
  derive() {
    return { fields: { article_type: "Lot" } };
  },
  queries(attrs) {
    return [{ component: "Prototype", filterKey: `origin_lot=${attrs.name}` }];
  },
});

export const Download = defineComponent({
  name: "Download",
  placement: "block",
  description: "Download box for a hosted file, with external mirrors",
  attrs: {
    file: { type: "media", queryable: true },
    /** Array of external mirror URLs. */
    external: { type: "json" },
    raw: { type: "media" },
    title: { type: "string" },
  },
});

export const FileList = defineComponent({
  name: "FileList",
  placement: "block",
  children: ["FileEntry"],
  description: "Table wrapper for FileEntry rows",
  attrs: {},
});

export const FileEntry = defineComponent({
  name: "FileEntry",
  placement: "block",
  description: "One file row inside a FileList",
  attrs: {
    n: { type: "number" },
    filename: { type: "string", required: true, queryable: true, searchable: true },
    game: { type: "string" },
    type: { type: "string" },
    date: { type: "string" },
    size: { type: "number", queryable: true },
    comment: { type: "string" },
    crc32: { type: "string" },
    md5: { type: "string" },
    sha1: { type: "string", queryable: true },
    sha256: { type: "string", queryable: true },
    indent: { type: "number" },
  },
});

export const HexDump = defineComponent({
  name: "HexDump",
  placement: "block",
  children: "json",
  description: "Header hex dump; the fenced JSON child holds { lines, annotations }",
  attrs: {},
});

export const GameNav = defineComponent({
  name: "GameNav",
  placement: "block",
  description: "Navbox listing prototypes and videos of a game",
  attrs: {
    game: { type: "string", required: true },
  },
  queries(attrs) {
    return ["Prototype", "Video"].map((component) => ({
      component,
      filterKey: `game=${attrs.game}`,
    }));
  },
});

export const HardwareSystem = defineComponent({
  name: "HardwareSystem",
  placement: "block",
  description: "Photo tile grid of all boards for one system",
  attrs: {
    system: { type: "string", required: true },
  },
  queries(attrs) {
    return [{ component: "Board", filterKey: `system=${attrs.system}` }];
  },
});

export const RegionDate = defineComponent({
  name: "RegionDate",
  placement: "inline",
  description: "A release date qualified by region",
  attrs: {
    region: { type: "string", required: true },
    date: { type: "string", required: true },
  },
});

export const TcrfLink = defineComponent({
  name: "TcrfLink",
  // Renders as a standalone panel on real pages ({{Tcrf link}} sits alone
  // under a heading), so block despite looking chip-like.
  placement: "block",
  description: "Panel linking to the matching tcrf.net article",
  attrs: {
    page: { type: "string", required: true },
  },
});

export const hpComponents: ComponentSpec[] = [
  Prototype,
  Board,
  Video,
  Lot,
  Download,
  FileList,
  FileEntry,
  HexDump,
  GameNav,
  HardwareSystem,
  RegionDate,
  TcrfLink,
];
