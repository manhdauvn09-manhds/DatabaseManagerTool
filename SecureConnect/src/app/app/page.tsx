"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { encryptPasswordRSAOAEP, type PublicKeyResponse } from "@/lib/crypto/client";

type DbType = "auto" | "mysql" | "postgresql" | "mssql";

type ProfileMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type StoredPayload = {
  dbType: DbType;
  host: string;
  port: number;
  user: string;
  password: string;
  ssl?: boolean;
};

export default function AppPage() {
  const router = useRouter();
  const [dbType, setDbType] = useState<DbType>("auto");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(3306);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);

  // Saved-connection state
  const [savedProfiles, setSavedProfiles] = useState<ProfileMeta[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);

  // Save modal
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Track which profile is being loaded (for spinner)
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => host.trim().length > 0 && port > 0 && password.length > 0,
    [host, port, password]
  );
  const canSave = canSubmit;

  const refreshSaved = useCallback(async () => {
    try {
      const res = await fetch("/api/saved-connections", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401) return;
        if (res.status === 503) return; // feature not configured server-side
        throw new Error("Failed to load saved");
      }
      const j = (await res.json()) as { profiles: ProfileMeta[] };
      setSavedProfiles(j.profiles ?? []);
      setSavedError(null);
    } catch (e) {
      setSavedError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => { refreshSaved(); }, [refreshSaved]);

  async function fetchPublicKey(): Promise<PublicKeyResponse> {
    const res = await fetch("/api/crypto/public-key", { cache: "no-store" });
    if (!res.ok) throw new Error("Cannot fetch public key");
    return res.json();
  }

  async function onConnect() {
    setMessage(null);
    setLoading(true);
    try {
      const { keyId, publicJwk } = await fetchPublicKey();
      const passwordEncrypted = await encryptPasswordRSAOAEP(password, publicJwk);
      setPassword("");
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dbType,
          host,
          port,
          user: user || undefined,
          passwordEncrypted,
          keyId
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data?.error?.message || "Connect failed");
        return;
      }
      setConnectionId(data.connectionId);
      setMessage("Connected. Mở explorer…");
      router.push(`/app/explorer?cid=${encodeURIComponent(data.connectionId)}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  // ----- Save profile (server-encrypted) -----
  function openSave() {
    setSaveName("");
    setSaveErr(null);
    setSaveOpen(true);
  }

  async function submitSave() {
    setSaveErr(null);
    if (!saveName.trim()) { setSaveErr("Tên profile không được trống."); return; }
    setSaveBusy(true);
    try {
      const data: StoredPayload = { dbType, host, port, user, password };
      const res = await fetch("/api/saved-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), data })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      setSaveOpen(false);
      await refreshSaved();
      setMessage(`Đã lưu profile (server-encrypted): ${saveName.trim()}`);
      setTimeout(() => setMessage(null), 4000);
    } catch (e) {
      setSaveErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSaveBusy(false);
    }
  }

  // ----- Load profile -----
  async function loadAndFill(p: ProfileMeta) {
    setLoadingId(p.id);
    setSavedError(null);
    try {
      const res = await fetch(`/api/saved-connections/${encodeURIComponent(p.id)}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      const data = j.data as StoredPayload;
      setDbType(data.dbType);
      setHost(data.host);
      setPort(data.port);
      setUser(data.user ?? "");
      setPassword(data.password);
      setMessage(`Đã load: ${p.name}. Nhấn Connect để kết nối.`);
      setTimeout(() => setMessage(null), 5000);
    } catch (e) {
      setSavedError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoadingId(null);
    }
  }

  async function deleteProfile(p: ProfileMeta) {
    if (!confirm(`Xoá profile "${p.name}"? Không thể khôi phục.`)) return;
    try {
      const res = await fetch(`/api/saved-connections/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      }
      await refreshSaved();
    } catch (e) {
      setSavedError(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">DatabaseManager</h1>
            <p className="text-sm text-zinc-600">Secure Connect (HTTPS + RSA-OAEP in browser)</p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/app/tokens" className="text-sm px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50" title="API tokens for the CLI">
              🔑 API Tokens
            </a>
            <button className="text-sm px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50" onClick={() => signOut({ callbackUrl: "/signin" })}>
              Sign out
            </button>
          </div>
        </header>

        <section className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 rounded-2xl bg-white border border-zinc-200 shadow-sm p-5">
            <h2 className="text-lg font-semibold">Connect</h2>
            <p className="mt-1 text-sm text-zinc-600">
              Password được mã hoá ở browser trước khi gửi (defense-in-depth). Production bắt buộc HTTPS.
            </p>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-sm">
                Database Type
                <select
                  className="mt-1 w-full rounded-xl border p-2"
                  value={dbType}
                  onChange={(e) => setDbType(e.target.value as DbType)}
                  autoComplete="off"
                >
                  <option value="auto">Auto</option>
                  <option value="mysql">MySQL</option>
                  <option value="postgresql">PostgreSQL</option>
                  <option value="mssql">MSSQL</option>
                </select>
              </label>

              <label className="text-sm">
                Host
                <input
                  className="mt-1 w-full rounded-xl border p-2"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="127.0.0.1"
                  maxLength={253}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </label>

              <label className="text-sm">
                Port
                <input
                  className="mt-1 w-full rounded-xl border p-2"
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  min={1}
                  max={65535}
                  autoComplete="off"
                />
              </label>

              <label className="text-sm">
                User (optional)
                <input
                  className="mt-1 w-full rounded-xl border p-2"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="root / postgres / sa"
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </label>

              <label className="text-sm md:col-span-2">
                Password
                <input
                  className="mt-1 w-full rounded-xl border p-2"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  maxLength={256}
                  autoComplete="new-password"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </label>
            </div>

            <div className="mt-4 flex items-center gap-3 flex-wrap">
              <button
                className="rounded-xl bg-zinc-900 text-white px-5 py-2.5 font-medium disabled:opacity-50"
                disabled={!canSubmit || loading}
                onClick={onConnect}
              >
                {loading ? "Connecting…" : "Connect"}
              </button>
              <button
                className="rounded-xl bg-white border px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                disabled={!canSave}
                onClick={openSave}
                title="Lưu credential — server mã hoá AES-256-GCM trước khi ghi đĩa"
              >
                💾 Save credentials…
              </button>
              {connectionId && (
                <span className="text-xs rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-3 py-1">
                  Connected
                </span>
              )}
            </div>

            {message && (
              <div className="mt-4 text-sm rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                {message}
              </div>
            )}
          </div>

          <div className="rounded-2xl bg-white border border-zinc-200 shadow-sm p-5">
            <h3 className="font-semibold">Security checklist</h3>
            <ul className="mt-2 text-sm text-zinc-700 space-y-1 list-disc pl-5">
              <li>Auth gate + email allowlist</li>
              <li>Password mã hoá RSA-OAEP trước gửi</li>
              <li>Saved credentials: AES-256-GCM at rest (HKDF + master key)</li>
              <li>Per-user key derive — user khác không decrypt được</li>
              <li>Production bắt buộc HTTPS</li>
            </ul>
          </div>
        </section>

        {/* Saved connections list */}
        <section className="mt-4 rounded-2xl bg-white border border-zinc-200 shadow-sm p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Saved connections</h3>
            <span className="text-xs text-zinc-500">{savedProfiles.length} profile(s) — server-encrypted</span>
          </div>
          {savedError && (
            <div className="mt-2 text-sm text-red-600 border border-red-200 bg-red-50 rounded-xl p-3">{savedError}</div>
          )}
          {savedProfiles.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              Chưa có profile nào. Điền form + nhấn <strong>Save credentials</strong> để lưu.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-100">
              {savedProfiles.map((p) => (
                <li key={p.id} className="py-2 flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-sm">{p.name}</div>
                    <div className="text-xs text-zinc-500">
                      Saved {new Date(p.updatedAt).toLocaleString()} · 🔒 AES-256-GCM
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => loadAndFill(p)}
                      disabled={loadingId === p.id}
                      className="text-xs px-3 py-1 rounded-xl border bg-white hover:bg-zinc-50 disabled:opacity-50"
                    >
                      {loadingId === p.id ? "Loading…" : "Load"}
                    </button>
                    <button
                      onClick={() => deleteProfile(p)}
                      className="text-xs px-3 py-1 rounded-xl border bg-white hover:bg-red-50 hover:border-red-300 text-red-600"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6 text-xs text-zinc-500">
          <p>
            Saved credentials được mã hoá ở server (AES-256-GCM với master key HKDF-derive per-user) trước khi ghi đĩa.
            File leak một mình không decrypt được — cần cả master key trên server. Server admin có thể decrypt khi cần.
          </p>
        </section>
      </div>

      {/* Save modal — just the profile name */}
      {saveOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => !saveBusy && setSaveOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <header className="px-5 py-3 border-b">
              <h2 className="text-base font-semibold">Save credentials</h2>
              <p className="text-xs text-zinc-500 mt-1">Server sẽ mã hoá AES-256-GCM rồi lưu.</p>
            </header>
            <div className="px-5 py-3 space-y-3 text-sm">
              <label className="block">
                <span>Profile name</span>
                <input
                  className="mt-1 w-full rounded-xl border p-2"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="Prod MySQL"
                  maxLength={64}
                  autoComplete="off"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") submitSave(); }}
                />
              </label>
              {saveErr && <div className="text-sm text-red-600 border border-red-200 bg-red-50 rounded-xl p-3">{saveErr}</div>}
            </div>
            <footer className="px-5 py-3 border-t flex items-center justify-end gap-2">
              <button onClick={() => setSaveOpen(false)} disabled={saveBusy} className="px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={submitSave} disabled={saveBusy || !saveName.trim()} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                {saveBusy ? "Saving…" : "Save"}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Footer with documentation links */}
      <footer className="mt-12 py-8 border-t border-zinc-200 text-center text-xs text-zinc-600 space-y-3">
        <div className="flex justify-center gap-4 flex-wrap">
          <a href="/user-manual.html" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">
            📚 User Manual
          </a>
          <span>•</span>
          <a href="/features.html" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">
            ✨ Features & Admin
          </a>
        </div>
        <div>
          <p>DatabaseManager • Secure database management with RSA-OAEP encryption</p>
          <p>© 2026 • Version 7.0.0 (100x improvements) • <a href="https://DBManager.allin1site.com/api/health" className="text-blue-600 hover:underline">Health Check</a></p>
        </div>
      </footer>
    </main>
  );
}
