"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Submission {
  sha256: string;
  nickname: string;
  status: string;
  submitted_at: string;
  reviewed_at: string | null;
  name: string;
  system: string;
  file_count: number;
}

const FILTERS = ["queued", "accepted", "rejected", ""] as const;

export default function Moderate() {
  const [status, setStatus] = useState<string>("queued");
  const [items, setItems] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [token, setToken] = useState<string>("");

  // Remember the moderation token locally so it isn't retyped each visit.
  useEffect(() => {
    setToken(localStorage.getItem("curator-mod-token") ?? "");
  }, []);
  function saveToken(t: string) {
    setToken(t);
    localStorage.setItem("curator-mod-token", t);
  }
  const authHeaders = useCallback(
    (extra: Record<string, string> = {}) => (token ? { ...extra, "x-moderation-token": token } : extra),
    [token],
  );

  const load = useCallback(async (s: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/submissions${s ? `?status=${s}` : ""}`, { headers: authHeaders() });
      if (res.status === 401) {
        setItems([]);
        setNote("Unauthorized — enter a valid moderation token.");
        return;
      }
      const data = await res.json();
      setItems(data.submissions ?? []);
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void load(status);
  }, [load, status]);

  async function moderate(sha256: string, action: "accept" | "reject") {
    setBusy(sha256);
    setNote("");
    try {
      const res = await fetch(`/api/submissions/${sha256}`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      setNote(res.ok ? `${action === "accept" ? "Accepted" : "Rejected"} ${sha256.slice(0, 12)}…` : `Error: ${data.error}`);
      await load(status);
    } catch (e) {
      setNote(`Failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Moderation</h1>
        <Link href="/" className="text-sm text-neutral-500 hover:underline">Search &rarr;</Link>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Review contributor submissions. Accepting ingests the build into the catalog.
      </p>

      <input
        type="password"
        value={token}
        onChange={(e) => saveToken(e.target.value)}
        onBlur={() => load(status)}
        placeholder="moderation token (x-moderation-token)"
        className="mt-5 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
      />

      <div className="mt-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f || "all"}
            onClick={() => setStatus(f)}
            className={`rounded-md px-3 py-1 text-sm ${
              status === f
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "border border-neutral-300 dark:border-neutral-700"
            }`}
          >
            {f || "all"}
          </button>
        ))}
      </div>

      {note && <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">{note}</p>}

      <div className="mt-4">
        {loading && <p className="text-sm text-neutral-500">Loading…</p>}
        {!loading && items.length === 0 && <p className="text-sm text-neutral-500">Nothing here.</p>}
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {items.map((s) => (
            <li key={s.sha256} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <Link href={`/build/${s.sha256}`} className="font-medium hover:underline">
                  {s.name ?? s.sha256}
                </Link>
                <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-neutral-500">
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{s.system ?? "?"}</span>
                  <span>{s.file_count ?? "?"} files</span>
                  <span>by {s.nickname}</span>
                  <span className="font-mono">{s.sha256.slice(0, 12)}…</span>
                  <StatusBadge status={s.status} />
                </div>
              </div>
              {s.status === "queued" && (
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => moderate(s.sha256, "accept")}
                    disabled={busy === s.sha256}
                    className="rounded-md bg-green-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => moderate(s.sha256, "reject")}
                    disabled={busy === s.sha256}
                    className="rounded-md border border-red-400 px-3 py-1 text-sm font-medium text-red-600 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tint =
    status === "accepted" ? "text-green-600" : status === "rejected" ? "text-red-500" : "text-amber-600";
  return <span className={`font-medium ${tint}`}>{status}</span>;
}
