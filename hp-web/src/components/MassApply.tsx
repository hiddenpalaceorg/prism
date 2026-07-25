"use client";

// Bulk moderation bar shown above a builds table while rows are selected:
// pick an action, fill it in, Apply hits POST /api/builds over the whole
// selection at once. Game suggestions come from the server as you type,
// exactly like the single-build editor on the build page.

import { useEffect, useState } from "react";
import Select from "@/components/Select";

type Action = "game" | "cleargame" | "lot" | "clearlot";

const ACTIONS: { value: Action; label: string }[] = [
  { value: "game", label: "Set game" },
  { value: "cleargame", label: "Clear game" },
  { value: "lot", label: "Set lot" },
  { value: "clearlot", label: "Clear lot" },
];

export default function MassApply({
  selected,
  token,
  onClear,
  onDone,
}: {
  /** sha256s of the selected builds. */
  selected: string[];
  /** Shared moderation token, "" when the wiki session is the credential. */
  token: string;
  /** Deselect everything (the bar's Clear button). */
  onClear: () => void;
  /** Called after a successful apply (refresh + deselect). */
  onDone: () => void;
}) {
  const [action, setAction] = useState<Action>("game");
  const [gameName, setGameName] = useState("");
  const [gameSys, setGameSys] = useState("");
  const [gameOpts, setGameOpts] = useState<{ name: string; system: string }[]>([]);
  const [lotName, setLotName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // Debounced game suggestions; stale responses are dropped.
  useEffect(() => {
    if (action !== "game") return;
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/games?q=${encodeURIComponent(gameName.trim())}`, { cache: "no-store" })
        .then((r) => r.json())
        .then(
          (d) =>
            !cancelled &&
            setGameOpts((d.games ?? []).map((g: { name: string; system: string }) => ({ name: g.name, system: g.system })))
        )
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [gameName, action]);

  const exact = gameOpts.filter((g) => g.name === gameName.trim());
  const sysOpts = [...new Set((exact.length ? exact : gameOpts).map((g) => g.system).filter(Boolean))];

  const ready =
    selected.length > 0 &&
    (action === "game" ? gameName.trim() !== "" : action === "lot" ? lotName.trim() !== "" : true);

  async function apply() {
    const fields =
      action === "game"
        ? { game: gameName.trim(), gameSystem: gameSys.trim() }
        : action === "cleargame"
          ? { game: null }
          : action === "lot"
            ? { lot: lotName.trim() }
            : { lot: null };
    setBusy(true);
    setNote("");
    try {
      const res = await fetch("/api/builds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-moderation-token": token } : {}),
        },
        body: JSON.stringify({ sha256s: selected, ...fields }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNote(`Error: ${data.error}`);
        return;
      }
      setNote(`Applied to ${data.updated} build${data.updated === 1 ? "" : "s"}.`);
      onDone();
    } catch (e) {
      setNote(`Failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  if (selected.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">
      <span className="text-xs font-medium text-neutral-500">
        {selected.length} selected
      </span>
      <button
        onClick={onClear}
        className="text-xs text-neutral-400 underline-offset-2 hover:underline"
      >
        clear
      </button>
      <Select
        value={action}
        onChange={(v) => setAction(v as Action)}
        ariaLabel="Bulk action"
        className="h-8 w-32 px-2 text-sm"
        options={ACTIONS}
      />
      {action === "game" && (
        <>
          <input
            list="prism-mass-game-names"
            value={gameName}
            onChange={(e) => setGameName(e.target.value)}
            placeholder="e.g. Baldur's Gate: Dark Alliance II"
            className="h-8 w-72 max-w-full rounded-md border border-neutral-300 bg-transparent px-2 outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
          />
          <datalist id="prism-mass-game-names">
            {[...new Set(gameOpts.map((g) => g.name))].map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <input
            list="prism-mass-game-systems"
            value={gameSys}
            onChange={(e) => setGameSys(e.target.value)}
            placeholder="System"
            className="h-8 w-32 max-w-full rounded-md border border-neutral-300 bg-transparent px-2 outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
          />
          <datalist id="prism-mass-game-systems">
            {sysOpts.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
      {action === "lot" && (
        <input
          value={lotName}
          onChange={(e) => setLotName(e.target.value)}
          placeholder="e.g. Sonic Month 2026"
          className="h-8 w-72 max-w-full rounded-md border border-neutral-300 bg-transparent px-2 outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
        />
      )}
      <button
        onClick={apply}
        disabled={busy || !ready}
        className="rounded-md border border-neutral-300 px-3 py-1 font-medium hover:border-neutral-500 disabled:opacity-40 disabled:hover:border-neutral-300 dark:border-neutral-700"
      >
        Apply
      </button>
      {note && <span className="text-xs text-neutral-500">{note}</span>}
    </div>
  );
}
