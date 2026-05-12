"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { encryptPasswordRSAOAEP, type PublicKeyResponse } from "@/lib/crypto/client";
import { encryptPayload, decryptPayload, type VaultBlob } from "@/lib/crypto/vault";

type DbType = "auto" | "mysql" | "postgresql" | "mssql";

type SavedProfile = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  salt: string;
  iv: string;
  ciphertext: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number };
};

type StoredPayload = {
  dbType: DbType;
  host: string;
  port: number;
  user: string;
  password: string;
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
  const [savedProfiles, setSavedProfiles] = useState<SavedProfile[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);

  // Save modal
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [savePass, setSavePass] = useState("");
  const [savePass2, setSavePass2] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Load modal
  const [loadProfile, setLoadProfile] = useState<SavedProfile | null>(null);
  const [loadPass, setLoadPass] = useState("");
  const [loadBusy, setLoadBusy] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => host.trim().length > 0 && port > 0 && password.length > 0,
    [host, port, password]
  );
  const canSave = useMemo(
    () => host.trim().length > 0 && port > 0 && password.length > 0,
    [host, port, password]
  );

  const refreshSaved = useCallback(async () => {
    try {
      const res = await fetch("/api/saved-connections", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401) return; // not signed in; ignore
        throw new Error("Failed to load saved");
      }
      const j = (await res.json()) as { profiles: SavedProfile[] };
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
      setMessage(`Connected. Mở explorer…`);
      router.push(`/app/explorer?cid=${encodeURIComponent(data.connectionId)}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  // ----- Save profile -----
  function openSave() {
    setSaveName("");
    setSavePass("");
    setSavePass2("");
    setSaveErr(null);
    setSaveOpen(true);
  }

  async function submitSave() {
    setSaveErr(null);
    if (!saveName.trim()) { setSaveErr("Tên profile không được trống."); return; }
    if (savePass.length < 8) { setSaveErr("Passphrase tối thiểu 8 ký tự."); return; }
    if (savePass !== savePass2) { setSaveErr("Passphrase xác nhận không khớp."); return; }
    setSaveBusy(true);
    try {
      const payload: StoredPayload = { dbType, host, port, user, password };
      const blob = await encryptPayload(savePass, payload);
      const res = await fetch("/api/saved-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), ...blob })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      setSaveOpen(false);
      // Best-effort: wipe passphrase from state.
      setSavePass("");
      setSavePass2("");
      await refreshSaved();
      setMessage(`Đã lưu profile: ${saveName.trim()}`);
      setTimeout(() => setMessage(null), 4000);
    } catch (e) {
      setSaveErr(String(e instanceof Error ? e.message : e));
    } finally {
      setSaveBusy(false);
    }
  }

  // ----- Load profile -----
  function openLoad(p: SavedProfile) {
    setLoadProfile(p);
    setLoadPass("");
    setLoadErr(null);
  }

  async function submitLoad() {
    if (!loadProfile) return;
    setLoadErr(null);
    setLoadBusy(true);
    try {
      const blob: VaultBlob = {
        salt: loadProfile.salt,
        iv: loadProfile.iv,
        ciphertext: loadProfile.ciphertext,
        kdf: loadProfile.kdf
      };
      const payload = await decryptPayload<StoredPayload>(loadPass, blob);
      setDbType(payload.dbType);
      setHost(payload.host);
      setPort(payload.port);
      setUser(payload.user);
      setPassword(payload.password);
      setLoadProfile(null);
      setLoadPass("");
      setMessage(`Đã load: ${loadProfile.name}. Nhấn Connect để kết nối.`);
      setTimeout(() => setMessage(null), 5000);
    } catch (e) {
      setLoadErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoadBusy(false);
    }
  }

  async function deleteProfile(p: SavedProfile) {
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
          <button className="text-sm px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50" onClick={() => signOut({ callbackUrl: "/signin" })}>
            Sign out
          </button>
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
                title="Mã hoá toàn bộ thông tin với passphrase rồi lưu vào server"
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
              <li>Saved credentials: AES-GCM với key từ passphrase (PBKDF2)</li>
              <li>Server không thấy plaintext credential</li>
              <li>Production bắt buộc HTTPS</li>
            </ul>
          </div>
        </section>

        {/* Saved connections list */}
        <section className="mt-4 rounded-2xl bg-white border border-zinc-200 shadow-sm p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Saved connections</h3>
            <span className="text-xs text-zinc-500">{savedProfiles.length} profile(s) — E2E encrypted</span>
          </div>
          {savedError && (
            <div className="mt-2 text-sm text-red-600 border border-red-200 bg-red-50 rounded-xl p-3">{savedError}</div>
          )}
          {savedProfiles.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              Chưa có profile nào. Điền form + nhấn <strong>Save credentials</strong> để lưu (cần passphrase).
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
                      onClick={() => openLoad(p)}
                      className="text-xs px-3 py-1 rounded-xl border bg-white hover:bg-zinc-50"
                    >
                      Load
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
            Saved credentials được mã hoá end-to-end bằng passphrase bạn nhập (PBKDF2 200k → AES-GCM).
            Server CHỈ lưu ciphertext — quên passphrase = mất data, không recover được.
          </p>
        </section>
      </div>

      {/* Save modal */}
      {saveOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => !saveBusy && setSaveOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <header className="px-5 py-3 border-b">
              <h2 className="text-base font-semibold">Save credentials (E2E encrypted)</h2>
              <p className="text-xs text-zinc-500 mt-1">Passphrase chỉ ở browser của bạn. Server không thể giải mã.</p>
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
                />
              </label>
              <label className="block">
                <span>Vault passphrase (≥ 8 ký tự)</span>
                <input
                  type="password"
                  className="mt-1 w-full rounded-xl border p-2"
                  value={savePass}
                  onChange={(e) => setSavePass(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="block">
                <span>Xác nhận passphrase</span>
                <input
                  type="password"
                  className="mt-1 w-full rounded-xl border p-2"
                  value={savePass2}
                  onChange={(e) => setSavePass2(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              {saveErr && <div className="text-sm text-red-600 border border-red-200 bg-red-50 rounded-xl p-3">{saveErr}</div>}
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
                ⚠️ Quên passphrase = không có cách nào lấy lại được credential. Lưu nó ở chỗ an toàn (password manager).
              </div>
            </div>
            <footer className="px-5 py-3 border-t flex items-center justify-end gap-2">
              <button onClick={() => setSaveOpen(false)} disabled={saveBusy} className="px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={submitSave} disabled={saveBusy} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                {saveBusy ? "Encrypting…" : "Save"}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Load modal */}
      {loadProfile && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => !loadBusy && setLoadProfile(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <header className="px-5 py-3 border-b">
              <h2 className="text-base font-semibold">Load: {loadProfile.name}</h2>
              <p className="text-xs text-zinc-500 mt-1">Decrypt bằng passphrase đã dùng lúc save.</p>
            </header>
            <div className="px-5 py-3 space-y-3 text-sm">
              <label className="block">
                <span>Vault passphrase</span>
                <input
                  type="password"
                  className="mt-1 w-full rounded-xl border p-2"
                  value={loadPass}
                  onChange={(e) => setLoadPass(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") submitLoad(); }}
                />
              </label>
              {loadErr && <div className="text-sm text-red-600 border border-red-200 bg-red-50 rounded-xl p-3">{loadErr}</div>}
            </div>
            <footer className="px-5 py-3 border-t flex items-center justify-end gap-2">
              <button onClick={() => setLoadProfile(null)} disabled={loadBusy} className="px-4 py-2 rounded-xl border bg-white hover:bg-zinc-50 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={submitLoad} disabled={loadBusy || loadPass.length === 0} className="px-4 py-2 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50">
                {loadBusy ? "Decrypting…" : "Load"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}
