"use client";

// Article-scoped error boundary. Wiki pages render page-authored components,
// and a single bad json payload used to take the whole route down with an
// unstyled 500. The Views coerce their inputs now; this is the backstop for
// whatever they do not anticipate, so one broken page stays one broken page.

import Link from "next/link";
import { useEffect } from "react";

export default function WikiPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("wiki page render failed", error);
  }, [error]);

  return (
    <main>
      <h1 className="mb-4 text-2xl font-semibold">This page could not be displayed</h1>
      <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
        Something in the page source failed to render. The rest of the wiki is unaffected.
        {error.digest ? (
          <>
            {" "}
            Reference <code className="font-mono">{error.digest}</code>.
          </>
        ) : null}
      </p>
      <p className="flex gap-3 text-sm">
        <button
          type="button"
          onClick={reset}
          className="rounded bg-neutral-900 px-3 py-1.5 text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Try again
        </button>
        <Link
          className="rounded border border-neutral-300 px-3 py-1.5 text-blue-600 hover:underline dark:border-neutral-700 dark:text-blue-400"
          href="/wiki/changes"
        >
          Recent changes
        </Link>
      </p>
    </main>
  );
}
