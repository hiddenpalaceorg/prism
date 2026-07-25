"use client";

// Host wrapper around cube's editor. cube owns the editing UI and the save
// protocol; this supplies what belongs to the site: HP's component specs, the
// URL scheme (?source, /login), App Router navigation after a save, and - since
// cube ships no CSS - the stylesheet for its cube-editor-* markers.

import { useRouter } from "next/navigation";
import { WikiEditor as CubeWikiEditor } from "cube/react";
import { hpComponents } from "@/cube/schemas";
import "./editor.css";

type Props = {
  title: string;
  canonicalHref: string;
  initialMarkdown: string;
  baseRevision: number | null;
  isNew: boolean;
};

export default function WikiEditor(props: Props) {
  const router = useRouter();
  return (
    <CubeWikiEditor
      {...props}
      specs={hpComponents}
      sourceHref={`${props.canonicalHref}?source`}
      loginHref={`/login?next=${encodeURIComponent(`${props.canonicalHref}?edit`)}`}
      onSaved={(href) => {
        router.push(href);
        router.refresh();
      }}
    />
  );
}
