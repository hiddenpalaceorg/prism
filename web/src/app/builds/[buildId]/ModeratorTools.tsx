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
  /** The game this build is assigned to (games.name), if any. */
  game: string | null;
  /** The build's own private flag. */
  privateFlag: boolean;
  /** Whether the build's lot is private (hides every build in it). */
  lotPrivate: boolean;
  /** Completeness categories marked not-applicable for this build. */
  skips: { skip_notes: boolean; skip_screenshots: boolean; skip_video: boolean; skip_physical: boolean };
}

// Rename + lot assignment, shown when a moderation token is saved (the
// /moderate page keeps it in sessionStorage) or the visitor's wiki session
// belongs to a moderator group. Purely cosmetic gating — the PATCH route
// re-checks credentials server-side. The parent keys this component on
// name+lot, so a router.refresh() after a save remounts it with fresh values.
export default function ModeratorTools({ sha256, name, lot, lots, game, privateFlag, lotPrivate, skips }: Props) {
  const router = useRouter();
  const token = useSyncExternalStore(noSubscribe, clientToken, serverToken);
  const [wikiModerator, setWikiModerator] = useState(false);
  const [nameInput, setNameInput] = useState(name);
  const [lotInput, setLotInput] = useState(lot ?? "");
  const [gameInput, setGameInput] = useState(game ?? "");
  const [gameOpts, setGameOpts] = useState<string[]>([]);
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

  // Game suggestions come from the server as you type (there are thousands of
  // games — too many to embed like the lot list). Debounced; stale responses
  // are dropped so a slow early query can't overwrite a fresh one.
  const visible = !!token || wikiModerator;
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/games?q=${encodeURIComponent(gameInput.trim())}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => !cancelled && setGameOpts((d.games ?? []).map((g: { name: string }) => g.name)))
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [gameInput, visible]);

  if (!visible) return null;

  async function saveTo(
    path: string,
    patch:
      | { name?: string; lot?: string | null; game?: string | null; private?: boolean; lotPrivate?: boolean }
      | { notes?: boolean; screenshots?: boolean; video?: boolean; physical?: boolean }
  ) {
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(path, {
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

  const save = (patch: { name?: string; lot?: string | null; game?: string | null; private?: boolean; lotPrivate?: boolean }) =>
    saveTo(`/api/build/${sha256}`, patch);
  const saveSkip = (patch: { notes?: boolean; screenshots?: boolean; video?: boolean; physical?: boolean }) =>
    saveTo(`/api/build/${sha256}/skip`, patch);

  const nameDirty = nameInput.trim() !== "" && nameInput.trim() !== name;
  const lotDirty = (lotInput.trim() || null) !== lot;
  const gameDirty = (gameInput.trim() || null) !== game;

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
        {/* Combobox: pick one of the server-suggested games or type a new
            title — saving an unknown name creates the game. */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Game</span>
          <div className="flex gap-2">
            <input
              list="prism-game-names"
              value={gameInput}
              onChange={(e) => setGameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && gameDirty && !busy && save({ game: gameInput.trim() || null })}
              placeholder="e.g. Sonic Adventure"
              className="h-9 w-72 max-w-full rounded-md border border-neutral-300 bg-transparent px-3 outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
            />
            <datalist id="prism-game-names">
              {gameOpts.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <button
              onClick={() => save({ game: gameInput.trim() || null })}
              disabled={busy || !gameDirty}
              className="rounded-md border border-neutral-300 px-3 py-1 font-medium hover:border-neutral-500 disabled:opacity-40 disabled:hover:border-neutral-300 dark:border-neutral-700"
            >
              {gameInput.trim() ? "Set game" : "Clear game"}
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
        {/* "Not applicable" markers for the completeness columns on /builds:
            a skipped category's 0 stops rendering orange there. */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Skip (not applicable)</span>
          <div className="flex h-9 items-center gap-5">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={skips.skip_notes}
                disabled={busy}
                onChange={(e) => saveSkip({ notes: e.target.checked })}
              />
              Notes
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={skips.skip_screenshots}
                disabled={busy}
                onChange={(e) => saveSkip({ screenshots: e.target.checked })}
              />
              Screenshots
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={skips.skip_video}
                disabled={busy}
                onChange={(e) => saveSkip({ video: e.target.checked })}
              />
              Video
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={skips.skip_physical}
                disabled={busy}
                onChange={(e) => saveSkip({ physical: e.target.checked })}
              />
              Physical
            </label>
          </div>
        </div>
      </div>
      {note && <p className="mt-2 text-xs text-neutral-500">{note}</p>}
    </section>
  );
}
