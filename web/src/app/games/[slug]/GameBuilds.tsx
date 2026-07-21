"use client";

// The game page's build list. For moderators each row grows a checkbox and
// a mass-apply bar appears while anything is selected (reassign a
// mis-filed build to another game, clear it, or move builds between lots).

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import MassApply from "@/components/MassApply";
import { useModerator } from "@/components/useModerator";
import { buildHref } from "@/lib/slug";
import type { BuildListItem } from "@/lib/queries";

function humanSize(bytes?: number): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

export default function GameBuilds({ builds }: { builds: BuildListItem[] }) {
  const router = useRouter();
  const { moderator, token } = useModerator();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (sha: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  const allSelected = builds.length > 0 && builds.every((b) => selected.has(b.sha256));

  if (builds.length === 0) {
    return <p className="mt-8 text-sm text-neutral-500">No public builds for this game.</p>;
  }

  return (
    <>
      {moderator && (
        <>
          <label className="mt-4 flex items-center gap-1.5 text-xs text-neutral-500">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(builds.map((b) => b.sha256)))
              }
            />
            Select all
          </label>
          <MassApply
            selected={[...selected]}
            token={token}
            onClear={() => setSelected(new Set())}
            onDone={() => {
              setSelected(new Set());
              router.refresh();
            }}
          />
        </>
      )}
      <ul className="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
        {builds.map((b) => (
          <li key={b.sha256} className="flex items-center gap-3">
            {moderator && (
              <input
                type="checkbox"
                checked={selected.has(b.sha256)}
                onChange={() => toggle(b.sha256)}
                aria-label={`Select ${b.name}`}
              />
            )}
            <Link
              href={buildHref(b.sha256, b.name)}
              className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <span className="min-w-0 flex-1 break-words font-medium">{b.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                {b.build_date ? b.build_date.slice(0, 10) : "—"}
              </span>
              <span className="w-20 shrink-0 text-right text-xs tabular-nums text-neutral-500">
                {humanSize(b.total_size)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
