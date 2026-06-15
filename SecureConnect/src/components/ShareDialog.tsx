"use client";

import { useCallback, useEffect, useState } from "react";

interface ShareItem {
  token: string;
  connectionId: string;
  createdAt: number;
  expiresAt: number;
}

export interface ShareDialogProps {
  connectionId: string;
  onClose: () => void;
}

const TTL_OPTIONS = [
  { label: "1 hour", sec: 3600 },
  { label: "6 hours", sec: 6 * 3600 },
  { label: "24 hours", sec: 24 * 3600 }
];

export function ShareDialog({ connectionId, onClose }: ShareDialogProps) {
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [ttlSec, setTtlSec] = useState(3600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const linkFor = (token: string) => `${origin}/app/explorer?share=${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/share", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { shares: ShareItem[] };
      // Only shares for THIS connection.
      setShares(d.shares.filter((s) => s.connectionId === connectionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load shares");
    }
  }, [connectionId]);

  useEffect(() => { void load(); }, [load]);

  async function createShare() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, ttlSec })
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create link");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(token)}`, { method: "DELETE" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      }
      setShares((s) => s.filter((x) => x.token !== token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke");
    } finally {
      setBusy(false);
    }
  }

  function copy(token: string) {
    const link = linkFor(token);
    navigator.clipboard?.writeText(link).then(
      () => { setCopied(token); setTimeout(() => setCopied(null), 1500); },
      () => setError("Copy failed — select and copy manually")
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => !busy && onClose()}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Share — read-only link</h2>
            <p className="text-xs text-zinc-500">Anyone signed in with Google + this link can browse this connection read-only. Revoke anytime.</p>
          </div>
          <button onClick={onClose} className="text-sm px-3 py-1 rounded-xl border bg-white hover:bg-zinc-50">Close</button>
        </header>

        <div className="px-5 py-3 border-b flex items-center gap-2">
          <span className="text-xs uppercase text-zinc-500">Expires in</span>
          <select className="rounded-lg border p-1 text-sm" value={ttlSec} onChange={(e) => setTtlSec(Number(e.target.value))} disabled={busy}>
            {TTL_OPTIONS.map((o) => <option key={o.sec} value={o.sec}>{o.label}</option>)}
          </select>
          <button
            onClick={createShare}
            disabled={busy}
            className="ml-auto text-sm px-4 py-1.5 rounded-lg border bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? "Working…" : "+ Create link"}
          </button>
        </div>

        {error && <div className="mx-5 mt-3 text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 p-3">{error}</div>}

        <div className="flex-1 overflow-auto px-5 py-3 space-y-2">
          {shares.length === 0 && <div className="text-sm text-zinc-500 py-6 text-center">No active links. Create one above.</div>}
          {shares.map((s) => (
            <div key={s.token} className="rounded-xl border border-zinc-200 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={linkFor(s.token)}
                  className="flex-1 rounded-lg border bg-zinc-50 px-2 py-1 text-xs font-mono"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button onClick={() => copy(s.token)} className="text-xs px-3 py-1 rounded-lg border bg-white hover:bg-zinc-50">
                  {copied === s.token ? "Copied!" : "Copy"}
                </button>
                <button onClick={() => revoke(s.token)} disabled={busy} className="text-xs px-3 py-1 rounded-lg border bg-white hover:bg-red-50 hover:border-red-300 text-red-600 disabled:opacity-50">
                  Revoke
                </button>
              </div>
              <div className="text-xs text-zinc-400">Expires {new Date(s.expiresAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
