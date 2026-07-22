/** Components cube ships. Sites add their own on top (and may not shadow these). */

import { defineComponent, type ComponentSpec } from "./schema/index";

export const Redirect = defineComponent({
  name: "Redirect",
  placement: "block",
  description: "Makes this page a redirect to another page.",
  attrs: {
    to: { type: "page", required: true },
  },
});

export const Category = defineComponent({
  name: "Category",
  placement: "block",
  description: "Adds this page to a category.",
  attrs: {
    name: { type: "string", required: true },
  },
});

export const DisplayTitle = defineComponent({
  name: "DisplayTitle",
  placement: "block",
  description: "Overrides the displayed page title.",
  attrs: {
    title: { type: "string", required: true },
  },
});

export const Include = defineComponent({
  name: "Include",
  placement: "block",
  description: "Transcludes another page's content.",
  attrs: {
    page: { type: "page", required: true },
  },
});

export const Toc = defineComponent({
  name: "TOC",
  placement: "block",
  description: "Table of contents for this page.",
  attrs: {},
});

export const Anchor = defineComponent({
  name: "Anchor",
  placement: "inline",
  description: "A named anchor for deep links.",
  attrs: {
    id: { type: "string", required: true },
  },
});

export const Image = defineComponent({
  name: "Image",
  placement: "inline",
  description: "An image from the media library.",
  attrs: {
    file: { type: "media", required: true },
    width: { type: "number" },
    height: { type: "number" },
    caption: { type: "string", searchable: true },
    link: { type: "page" },
  },
});

export const Gallery = defineComponent({
  name: "Gallery",
  placement: "block",
  description: "A grid of images.",
  attrs: {
    mode: { type: "enum", values: ["grid", "packed", "nolines"] as const, default: "grid" },
    heights: { type: "number" },
    widths: { type: "number" },
    images: { type: "json", required: true },
  },
  validate: (attrs) => {
    const images = attrs.images;
    if (!Array.isArray(images)) return [{ attr: "images", message: "images must be an array" }];
    for (const [i, img] of images.entries()) {
      if (typeof img !== "object" || img === null || typeof (img as { file?: unknown }).file !== "string") {
        return [{ attr: "images", message: `images[${i}] must be { "file": "...", "caption"?: "..." }` }];
      }
    }
    return [];
  },
});

export const YouTube = defineComponent({
  name: "YouTube",
  placement: "block",
  description: "An embedded YouTube video.",
  attrs: {
    id: { type: "string", required: true },
    title: { type: "string" },
  },
});

export const Query = defineComponent({
  name: "Query",
  placement: "block",
  description: "Lists pages by their structured data (the #ask replacement).",
  attrs: {
    from: { type: "json", required: true },
    where: { type: "json" },
    select: { type: "json" },
    sort: { type: "json" },
    limit: { type: "number" },
    format: {
      type: "enum",
      values: ["table", "ul", "count", "earliest", "latest", "inline", "render"] as const,
      default: "table",
    },
    /** Field for earliest/latest aggregates. */
    of: { type: "string" },
    /** Named site result renderer, for format="render". */
    render: { type: "string" },
    groupBy: { type: "string" },
    /** Column labels for table format, parallel to select. */
    headers: { type: "json" },
  },
});

export const builtinComponents: ComponentSpec[] = [
  Redirect,
  Category,
  DisplayTitle,
  Include,
  Toc,
  Anchor,
  Image,
  Gallery,
  YouTube,
  Query,
];
