"use client";

// Rendering/cropping progress note. The status endpoint self-heals (polling
// restarts a dead job), so this is a plain poll loop; the page refreshes once
// everything is done so the strip and crops appear without a manual reload.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

interface Status {
  assets: {
    state: string;
    error?: string;
    pages_total: number;
    pages_rendered: number;
    crops_total: number;
    crops_done: number;
  };
}

export default function RenderProgress({ issueId }: { issueId: number }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const done = useRef(false);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/mag/issues/${issueId}/status`, { cache: "no-store" });
        if (!r.ok) return;
        const s = (await r.json()) as Status;
        if (stop) return;
        setStatus(s);
        const a = s.assets;
        const complete =
          a.state !== "working" &&
          a.pages_total > 0 &&
          a.pages_rendered >= a.pages_total &&
          a.crops_done >= a.crops_total;
        if (complete && !done.current) {
          done.current = true;
          router.refresh();
        }
      } catch {
        // Transient; the next tick retries.
      }
    };
    void tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [issueId, router]);

  const a = status?.assets;
  return (
    <p className="mt-3 rounded-md border border-dashed border-neutral-300 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-700">
      {a
        ? a.state === "failed"
          ? `Rendering failed: ${a.error ?? "unknown error"} — polling retries automatically.`
          : `Rendering pages ${a.pages_rendered}/${a.pages_total || "?"}, crops ${a.crops_done}/${a.crops_total}…`
        : "Checking render status…"}
    </p>
  );
}
