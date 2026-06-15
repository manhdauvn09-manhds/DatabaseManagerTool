"use client";

import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";

type TokenMeta = {
  id: string;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
};

const TTL_OPTIONS = [
  { label: "Never", sec: 0 },
  { label: "30 days", sec: 30 * 86400 },
  { label: "90 days", sec: 90 * 86400 },
  { label: "1 year", sec: 365 * 86400 }
];

export default function TokensPage() {
  const [tokens, setTokens] = useState<TokenMeta[]>([]);
  const [label, setLabel] = useState("");
  const [ttlSec, setTtlSec] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tokens", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { tokens: TokenMeta[] };
      setTokens(d.tokens);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tokens");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (!label.trim()) { setError("Enter a label"); return; }
    setBusy(true);
    setError(null);
    setNewToken(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), ttlSec: ttlSec || undefined })
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      }
      const d = (await res.json()) as { token: string };
      setNewToken(d.token);
      setLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tokens/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error?.message ?? `HTTP ${res.status}`);
      }
      setTokens((t) => t.filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke");
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!newToken) return;
    navigator.clipboard?.writeText(newToken).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => setError("Copy failed — select and copy manually")
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 p-6">
      <div className="max-w-3xl mx-auto">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">API Tokens</h1>
            <p className="text-sm text-zinc-600">Personal access tokens for the <code className="bg-zinc-100 px-1 rounded">dbm</code> CLI. Acts as you. Revoke anytime.</p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/app" className="text-sm px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50">← Back</a>
            <button className="text-sm px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50" onClick={() => signOut({ callbackUrl: "/signin" })}>Sign out</button>
          </div>
        </header>

        {/* Create */}
        <section className="mt-6 rounded-2xl bg-white border border-zinc-200 p-5">
          <h2 className="font-semibold">Create a token</h2>
          <div className="mt-3 flex items-end gap-2 flex-wrap">
            <label className="flex-1 min-w-48">
              <span className="text-xs text-zinc-500">Label</span>
              <input
                className="mt-1 w-full rounded-xl border p-2 text-sm"
                placeholder="e.g. laptop CLI"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
              />
            </label>
            <label>
              <span className="text-xs text-zinc-500">Expires</span>
              <select className="mt-1 block rounded-xl border p-2 text-sm" value={ttlSec} onChange={(e) => setTtlSec(Number(e.target.value))}>
                {TTL_OPTIONS.map((o) => <option key={o.sec} value={o.sec}>{o.label}</option>)}
              </select>
            </label>
            <button onClick={create} disabled={busy} className="rounded-xl bg-emerald-600 text-white px-4 py-2 text-sm hover:bg-emerald-700 disabled:opacity-50">
              {busy ? "Working…" : "Create token"}
            </button>
          </div>

          {newToken && (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3">
              <div className="text-sm font-medium text-amber-900">Copy this token now — it won&apos;t be shown again.</div>
              <div className="mt-2 flex items-center gap-2">
                <input readOnly value={newToken} className="flex-1 rounded-lg border bg-white px-2 py-1 text-xs font-mono" onFocus={(e) => e.currentTarget.select()} />
                <button onClick={copy} className="text-xs px-3 py-1 rounded-lg border bg-white hover:bg-zinc-50">{copied ? "Copied!" : "Copy"}</button>
              </div>
              <div className="mt-2 text-xs text-amber-800">
                Use it: <code className="bg-white px-1 rounded">export DBM_TOKEN=&lt;token&gt;</code> then <code className="bg-white px-1 rounded">dbm databases --cid &lt;id&gt;</code>
              </div>
            </div>
          )}
        </section>

        {error && <div className="mt-4 text-sm rounded-xl border border-red-200 bg-red-50 text-red-700 p-3">{error}</div>}

        {/* List */}
        <section className="mt-6 rounded-2xl bg-white border border-zinc-200 p-5">
          <h2 className="font-semibold">Active tokens</h2>
          {tokens.length === 0 && <div className="text-sm text-zinc-500 py-6 text-center">No tokens yet.</div>}
          <div className="mt-3 space-y-2">
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded-xl border border-zinc-200 p-3">
                <div>
                  <div className="font-medium text-sm">{t.label}</div>
                  <div className="text-xs text-zinc-400">
                    Created {new Date(t.createdAt).toLocaleDateString()} ·
                    {t.expiresAt ? ` expires ${new Date(t.expiresAt).toLocaleDateString()}` : " no expiry"} ·
                    {t.lastUsedAt ? ` last used ${new Date(t.lastUsedAt).toLocaleString()}` : " never used"}
                  </div>
                </div>
                <button onClick={() => revoke(t.id)} disabled={busy} className="text-xs px-3 py-1 rounded-lg border bg-white hover:bg-red-50 hover:border-red-300 text-red-600 disabled:opacity-50">
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
