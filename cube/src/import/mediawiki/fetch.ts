/**
 * Live-wiki fetchers (converter dev + the continuous-sync worker later).
 * MW core REST v1 with_html carries inline data-mw (probe: the v3 Parsoid
 * endpoints are not registered on this install). Subpage slashes must be
 * percent-encoded in the title path segment.
 */

export type FetchedPage = {
  title: string;
  revisionId: number;
  html: string;
};

function encodeTitle(title: string): string {
  return encodeURIComponent(title.replace(/ /g, "_"));
}

export async function fetchParsoidHtml(baseUrl: string, title: string): Promise<FetchedPage> {
  const url = `${baseUrl.replace(/\/$/, "")}/w/rest.php/v1/page/${encodeTitle(title)}/with_html`;
  const res = await fetch(url, { headers: { "user-agent": "cube-import/0.1" } });
  if (!res.ok) throw new Error(`with_html ${res.status} for ${title}`);
  const body = (await res.json()) as { id: number; latest?: { id: number }; html: string; title?: string };
  return { title, revisionId: body.latest?.id ?? body.id, html: body.html };
}

export async function fetchRawWikitext(baseUrl: string, title: string): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/w/index.php?title=${encodeTitle(title)}&action=raw`;
  const res = await fetch(url, { headers: { "user-agent": "cube-import/0.1" } });
  if (!res.ok) throw new Error(`action=raw ${res.status} for ${title}`);
  return res.text();
}

export type RevisionInfo = {
  wikitext: string;
  revId: number;
  author: string;
  timestamp: Date;
  comment: string;
};

/** Current revision content + provenance (author/timestamp/comment) in one call. */
export async function fetchRevisionInfo(baseUrl: string, title: string): Promise<RevisionInfo> {
  const url =
    `${baseUrl.replace(/\/$/, "")}/w/api.php?action=query&prop=revisions` +
    `&rvprop=content|user|timestamp|comment|ids&rvslots=main&titles=${encodeTitle(title)}&format=json`;
  const res = await fetch(url, { headers: { "user-agent": "cube-import/0.1" } });
  if (!res.ok) throw new Error(`revisions api ${res.status} for ${title}`);
  const body = (await res.json()) as {
    query?: { pages?: Record<string, { revisions?: {
      revid: number; user?: string; timestamp: string; comment?: string;
      slots?: { main?: { "*"?: string } }; "*"?: string;
    }[] }> };
  };
  const page = Object.values(body.query?.pages ?? {})[0];
  const rev = page?.revisions?.[0];
  const wikitext = rev?.slots?.main?.["*"] ?? rev?.["*"];
  if (!rev || wikitext === undefined) throw new Error(`no revision content for ${title}`);
  return {
    wikitext,
    revId: rev.revid,
    author: rev.user ?? "unknown",
    timestamp: new Date(rev.timestamp),
    comment: rev.comment ?? "",
  };
}
