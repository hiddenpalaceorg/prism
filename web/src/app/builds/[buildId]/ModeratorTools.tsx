"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

// The token never changes while the page is mounted (it's set on /moderate),
// so there is nothing to subscribe to — the store only bridges the SSR/client
// gap: the server snapshot renders nothing, hydration reveals the saved token.
const noSubscribe = () => () => {};
const clientToken = () => sessionStorage.getItem("prism-mod-token") ?? "";
const serverToken = () => "";

interface Props {
  sha256: string;
  name: string;
  lot: string | null;
  /** Existing lot names, offered as suggestions when assigning. */
  lots: string[];
  /** The build's own private flag. */
  privateFlag: boolean;
  /** Whether the build's lot is private (hides every build in it). */
  lotPrivate: boolean;
}

// Rename + lot assignment, shown when a moderation token is saved (the
// /moderate page keeps it in sessionStorage) or the visitor's wiki session
// belongs to a moderator group. Purely cosmetic gating — the PATCH route
// re-checks credentials server-side. The parent keys this component on
// name+lot, so a router.refresh() after a save remounts it with fresh values.
export default function ModeratorTools({ sha256, name, lot, lots, privateFlag, lotPrivate }: Props) {
  const router = useRouter();
  const token = useSyncExternalStore(noSubscribe, clientToken, serverToken);
  const [wikiModerator, setWikiModerator] = useState(false);
  const [nameInput, setNameInput] = useState(name);
  const [lotInput, setLotInput] = useState(lot ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

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

  if (!token && !wikiModerator) return null;

  async function save(patch: { name?: string; lot?: string | null; private?: boolean; lotPrivate?: boolean }) {
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(`/api/build/${sha256}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-moderation-token": token } : {}),
        },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) {
        setNote(`Error: ${data.error}`);
        return;
      }
      setNote("Saved.");
      router.refresh();
    } catch (e) {
      setNote(`Failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const nameDirty = nameInput.trim() !== "" && nameInput.trim() !== name;
  const lotDirty = (lotInput.trim() || null) !== lot;

  return (
    <section className="mt-6 rounded-md border border-dashed border-neutral-300 px-4 py-3 dark:border-neutral-700">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Moderator</h2>
      <div className="mt-2 flex flex-wrap items-end gap-x-8 gap-y-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Name</span>
          <div className="flex gap-2">
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && nameDirty && !busy && save({ name: nameInput.trim() })}
              className="h-9 w-96 max-w-full rounded-md border border-neutral-300 bg-transparent px-3 outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
            <button
              onClick={() => save({ name: nameInput.trim() })}
              disabled={busy || !nameDirty}
              className="rounded-md border border-neutral-300 px-3 py-1 font-medium hover:border-neutral-500 disabled:opacity-40 disabled:hover:border-neutral-300 dark:border-neutral-700"
            >
              Rename
            </button>
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Lot</span>
          <div className="flex gap-2">
            <input
              list="prism-lot-names"
              value={lotInput}
              onChange={(e) => setLotInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && lotDirty && !busy && save({ lot: lotInput.trim() || null })}
              placeholder="e.g. Sonic Month 2026"
              className="h-9 w-72 max-w-full rounded-md border border-neutral-300 bg-transparent px-3 outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
            />
            <datalist id="prism-lot-names">
              {lots.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            <button
              onClick={() => save({ lot: lotInput.trim() || null })}
              disabled={busy || !lotDirty}
              className="rounded-md border border-neutral-300 px-3 py-1 font-medium hover:border-neutral-500 disabled:opacity-40 disabled:hover:border-neutral-300 dark:border-neutral-700"
            >
              {lotInput.trim() ? "Set lot" : "Clear lot"}
            </button>
          </div>
        </label>
        {/* Checkbox state comes straight from props: a successful save triggers
            router.refresh() and the parent's key remounts this component. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Visibility</span>
          <div className="flex h-9 items-center gap-5">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={privateFlag}
                disabled={busy}
                onChange={(e) => save({ private: e.target.checked })}
              />
              Private build
            </label>
            <label className={`flex items-center gap-1.5 ${lot ? "" : "opacity-40"}`}>
              <input
                type="checkbox"
                checked={lotPrivate}
                disabled={busy || !lot}
                onChange={(e) => save({ lotPrivate: e.target.checked })}
              />
              Private lot
            </label>
          </div>
        </div>
      </div>
      {note && <p className="mt-2 text-xs text-neutral-500">{note}</p>}
    </section>
  );
}
