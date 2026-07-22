// The cube wiki-engine instance for hiddenpalace.org. Lazy singleton
// mirroring lib/db.ts getPool(). Server-only.

import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { createCube, cubeNativeAuth, localDirStorage, type Cube } from "cube";
import { getPool } from "@/lib/db";
import { hpComponents } from "./schemas";

let instance: Cube | undefined;

export function getCube(): Cube {
  if (!instance) {
    instance = createCube({
      db: { pool: getPool },
      auth: cubeNativeAuth({
        pool: getPool,
        secure: process.env.NODE_ENV === "production",
      }),
      components: hpComponents,
      // Local dir for now; the S3 adapter (files bucket, cube/ prefix) is the
      // production wiring once the media milestone cuts over.
      storage: localDirStorage({
        dir: process.env.CUBE_MEDIA_DIR ?? join(process.cwd(), "cube-media"),
        publicBase: undefined,
      }),
      site: {
        apiBasePath: "/api/cube",
        homeSlug: "Main_Page",
        interwiki: { tcrf: "https://tcrf.net/$1" },
      },
      onInvalidate: (tags, pages) => {
        // Wiki pages live at root; revalidate the edited page and every page
        // whose queries depend on the changed objects.
        for (const tag of tags) {
          const m = /^cube:page:main:(.+)$/.exec(tag);
          if (m) revalidatePath(`/${m[1]}`);
        }
        for (const p of pages) {
          revalidatePath(p.ns === "main" ? `/${p.slug}` : `/${nsPrefix(p.ns)}:${p.slug}`);
        }
      },
    });
  }
  return instance;
}

export function nsPrefix(ns: string): string {
  return ns.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()).replace(/ /g, "_");
}

/** Root-relative URL for a page ref (the host owns the URL scheme). */
export function pageHref(ref: { ns: string; slug: string }): string {
  const path = ref.ns === "main" ? ref.slug : `${nsPrefix(ref.ns)}:${ref.slug}`;
  return `/${path.split("/").map(encodeURIComponent).join("/")}`;
}
