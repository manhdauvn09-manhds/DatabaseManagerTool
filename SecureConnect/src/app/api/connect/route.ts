import { NextResponse } from "next/server";
import { authorizeUser } from "@/lib/db-api/route-helper";
import { ConnectRequestSchema } from "@/lib/schemas/connect";
import { decryptBase64RSAOAEP, getOrCreateServerKey } from "@/lib/crypto/serverKeyStore";
import { cleanupExpired, createConnectionRecord } from "@/lib/connections/store";
import { testConnection } from "@/lib/connections/testConnection";
import { ensureSafeHost } from "@/lib/security/ssrfGuard";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const maxDuration = 15;

const MAX_BODY_BYTES = 4096;

function jsonError(code: string, message: string, status: number, extraHeaders?: Record<string, string>) {
  return NextResponse.json({ error: { code, message } }, { status, headers: extraHeaders });
}

export async function POST(req: Request) {
  const t0 = Date.now();

  // Auth: cookie session (Origin/CSRF checked) OR Bearer PAT (CLI; CSRF n/a).
  // Per-user rate limit: 10 attempts / minute on the "connect" bucket.
  const a = await authorizeUser(req, "connect", { rateLimitMax: 10, rateLimitWindowMs: 60_000, rateLimitBucket: "connect" });
  if (!a.ok) return a.response;
  const { email, ip } = a.ctx;

  // Body size cap (mitigates payload-DoS).
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    audit({ action: "connect", email, ip, ok: false, errCode: "BODY_TOO_LARGE" });
    return jsonError("BODY_TOO_LARGE", "Payload too large", 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("BAD_REQUEST", "Invalid JSON", 400);
  }

  await cleanupExpired();

  const parsed = ConnectRequestSchema.safeParse(body);
  if (!parsed.success) {
    audit({ action: "connect", email, ip, ok: false, errCode: "BAD_REQUEST" });
    return jsonError("BAD_REQUEST", "Invalid payload", 400);
  }

  const { keyId, dbType, host, port, user, passwordEncrypted, ssl } = parsed.data;

  // SSRF guard. Pass allowPrivate=true via env when the target DB lives on a LAN/RFC1918 host
  // that the operator trusts. Loopback / 169.254 (cloud metadata) is ALWAYS blocked.
  const allowPrivate = process.env.ALLOW_PRIVATE_HOSTS === "true";
  const safe = await ensureSafeHost(host, { allowPrivate });
  if (!safe.ok) {
    audit({ action: "connect", email, ip, host, port, ok: false, errCode: "HOST_BLOCKED", ms: Date.now() - t0 });
    return jsonError("HOST_BLOCKED", "Host not allowed", 403);
  }

  const serverKey = await getOrCreateServerKey();
  if (serverKey.keyId !== keyId) {
    audit({ action: "connect", email, ip, host, port, ok: false, errCode: "KEY_ROTATED" });
    return jsonError("KEY_ROTATED", "Encryption key rotated. Refresh public key and retry.", 409);
  }

  let password: string;
  try {
    password = await decryptBase64RSAOAEP(passwordEncrypted);
  } catch {
    audit({ action: "connect", email, ip, host, port, ok: false, errCode: "DECRYPT_FAIL" });
    return jsonError("DECRYPT_FAIL", "Cannot decrypt password", 400);
  }
  if (!password) {
    audit({ action: "connect", email, ip, host, port, ok: false, errCode: "BAD_PASSWORD" });
    return jsonError("BAD_PASSWORD", "Password is required", 400);
  }

  const result = await testConnection({
    ownerEmail: email,
    dbType,
    host,
    port,
    user,
    password,
    ssl,
    // Pass the IP we already vetted so the driver connects to the SAME address,
    // closing the DNS-rebinding window between SSRF check and driver lookup.
    resolvedIp: safe.ip,
    mssqlTrustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERT === "true"
  });

  if (!result.ok) {
    if (result.internalReason) {
      // Server-side detail for ops/forensics. Never sent to client.
      // eslint-disable-next-line no-console
      console.error("[connect] driver error:", result.internalReason);
    }
    audit({ action: "connect", email, ip, host, port, dbType, ok: false, errCode: "CONNECT_FAIL", ms: Date.now() - t0 });
    return jsonError("CONNECT_FAIL", "Unable to connect to database", 400);
  }

  const rec = await createConnectionRecord({
    ownerEmail: email,
    dbType: result.dbType,
    host,
    port,
    user,
    password,
    resolvedIp: safe.ip
  });
  password = "";

  audit({ action: "connect", email, ip, host, port, dbType: result.dbType, ok: true, ms: Date.now() - t0 });
  return NextResponse.json({ connectionId: rec.id, dbType: rec.dbType });
}
