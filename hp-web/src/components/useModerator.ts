"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

// The token never changes while a page is mounted (it's set on /moderate),
// so there is nothing to subscribe to — the store only bridges the
// SSR/client gap: the server snapshot renders nothing, hydration reveals
// the saved token.
const noSubscribe = () => () => {};
const clientToken = () => sessionStorage.getItem("prism-mod-token") ?? "";
const serverToken = () => "";

/** Moderator UI gating: the shared token saved by /moderate, or a wiki
 *  session whose user is in a moderator group. Purely cosmetic — every
 *  mutating route re-checks credentials server-side. */
export function useModerator(): { moderator: boolean; token: string } {
  const token = useSyncExternalStore(noSubscribe, clientToken, serverToken);
  const [wikiModerator, setWikiModerator] = useState(false);

  useEffect(() => {
    if (token) return;
    let cancelled = false;
    fetch("/api/whoami", { cache: "no-store" })
      .then((r) => r.json())
      .then((w) => !cancelled && setWikiModerator(!!w.moderator))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  return { moderator: !!token || wikiModerator, token };
}
