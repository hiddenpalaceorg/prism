// Magazine URL helpers. Client-safe: no server-only imports (client
// components build these links too). Blob URLs go through the app routes,
// which 307 to the public gateway when one is configured.

export function magazineHref(magSlug: string): string {
  return `/magazines/${magSlug}`;
}

export function issueHref(magSlug: string, issueSlug: string): string {
  return `/magazines/${magSlug}/${issueSlug}`;
}

/** Fragment id of one extract on its issue page (lightbox deep links use the
 *  same convention as build media: navigation state lives in the URL). */
export function extractAnchor(id: number): string {
  return `x-${id}`;
}

export function magBlobUrl(sha256: string): string {
  return `/api/mag/blob/${sha256}`;
}

export function magThumbUrl(sha256: string, w: 500 | 1000 = 500): string {
  return `/api/mag/blob/${sha256}/thumb?w=${w}`;
}

export function personHref(slug: string): string {
  return `/people/${slug}`;
}
