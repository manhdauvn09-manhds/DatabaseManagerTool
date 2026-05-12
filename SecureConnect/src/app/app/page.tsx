"use client";

import { useEffect, useMemo, useState } from "react";
import { signOut } from "next-auth/react";
import { encryptPasswordRSAOAEP, type PublicKeyResponse } from "@/lib/crypto/client";

type DbType = "auto" | "mysql" | "postgresql" | "mssql";

export default function AppPage() {
  const [dbType, setDbType] = useState<DbType>("auto");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(3306);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);

  const canSubmit = useMemo(() => host.trim().length > 0 && port > 0 && password.length > 0, [host, port, password]);

  async function fetchPublicKey(): Promise<PublicKeyResponse> {
    const res = await fetch("/api/crypto/public-key", { cache: "no-store" });
    if (!res.ok) throw new Error("Cannot fetch public key");
    return res.json();
  }

  async function onConnect() {
    setMessage(null);
    setLoading(true);
    try {
      // 1) Get public key
      const { keyId, publicJwk } = await fetchPublicKey();

      // 2) Encrypt password in the browser (defense-in-depth)
      const passwordEncrypted = await encryptPasswordRSAOAEP(password, publicJwk);

      // 3) Immediately clear password from state (best-effort)
      setPassword("");

      // 4) Call connect API (still MUST be HTTPS in production)
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
      setMessage(`Connected OK. connectionId=${data.connectionId} (type=${data.dbType})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unexpected error";
      setMessage(msg);
    } finally {
      setLoading(false);
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

            <div className="mt-4 flex items-center gap-3">
              <button
                className="rounded-xl bg-zinc-900 text-white px-5 py-2.5 font-medium disabled:opacity-50"
                disabled={!canSubmit || loading}
                onClick={onConnect}
              >
                {loading ? "Connecting…" : "Connect"}
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
              <li>Auth gate: /app và /api/* yêu cầu sign-in</li>
              <li>Password không lưu localStorage/sessionStorage</li>
              <li>Password được mã hoá (RSA-OAEP) trước khi gửi</li>
              <li>Backend decrypt và giữ secret in-memory (TTL)</li>
              <li>Production phải dùng HTTPS (TLS)</li>
            </ul>
          </div>
        </section>

        <section className="mt-6 text-xs text-zinc-500">
          <p>
            Ghi chú: Client-side encryption chỉ là defense-in-depth. HTTPS vẫn là lớp bảo vệ chính.
            Với multi-instance production, public key nên được quản lý ổn định (KMS) để tránh KEY_ROTATED.
          </p>
        </section>
      </div>
    </main>
  );
}
