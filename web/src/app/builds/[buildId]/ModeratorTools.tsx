"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

// The token never changes while the page is mounted (it's set on /moderate),
// so there is nothing to subscribe to — the store only bridges the SSR/client
// gap: the server snapshot renders nothing, hydration reveals the saved token.
const noSubscribe = () => () => {};
const clientToken = () => sessionStorage.getItem("curator-mod-token") ?? "";
const serverToken = () => "";

interface Props {
  sha256: string;
  name: string;
  lot: string | null;
  /** Existing lot names, offered as suggestions when assigning. */
  lots: string[];
}

// Rename + lot assignment, shown only when a moderation token is saved (the
// /moderate page keeps it in sessionStorage). Purely cosmetic gating — the
// PATCH route re-checks the token server-side. The parent keys this component
// on name+lot, so a router.refresh() after a save remounts it with fresh values.
export default function ModeratorTools({ sha256, name, lot, lots }: Props) {
  const router = useRouter();
  const token = useSyncExternalStore(noSubscribe, clientToken, serverToken);
  const [nameInput, setNameInput] = useState(name);
  const [lotInput, setLotInput] = useState(lot ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  if (!token) return null;

  async function save(patch: { name?: string; lot?: string | null }) {
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(`/api/build/${sha256}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-moderation-token": token },
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
              list="curator-lot-names"
              value={lotInput}
              onChange={(e) => setLotInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && lotDirty && !busy && save({ lot: lotInput.trim() || null })}
              placeholder="e.g. Sonic Month 2026"
              className="h-9 w-72 max-w-full rounded-md border border-neutral-300 bg-transparent px-3 outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
            />
            <datalist id="curator-lot-names">
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
      </div>
      {note && <p className="mt-2 text-xs text-neutral-500">{note}</p>}
    </section>
  );
}
