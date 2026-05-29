import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { ConnectRequestSchema } from "@/lib/schemas/connect";
import { decryptBase64RSAOAEP, getOrCreateServerKey } from "@/lib/crypto/serverKeyStore";
import { cleanupExpired, createConnectionRecord } from "@/lib/connections/store";
import { testConnection } from "@/lib/connections/testConnection";
import { ensureSafeHost } from "@/lib/security/ssrfGuard";
import { rateLimit, getClientIp } from "@/lib/security/rateLimit";
import { audit } from "@/lib/security/auditLog";

export const runtime = "nodejs";
export const maxDuration = 15;

const MAX_BODY_BYTES = 4096;

function jsonError(code: string, message: string, status: number, extraHeaders?: Record<string, string>) {
  return NextResponse.json({ error: { code, message } }, { status, headers: extraHeaders });
}

export async function POST(req: Request) {
  const t0 = Date.now();
  const ip = getClientIp(req);

  // CSRF defense-in-depth: when AUTH_URL is configured, require Origin/Referer to match.
  // SameSite=Lax cookies already block classic CSRF; this catches edge cases (e.g. iframes).
  // Comparison is case-insensitive per RFC 3986 (scheme+host are case-insensitive).
  const expectedOrigin = process.env.AUTH_URL?.toLowerCase();
  if (expectedOrigin) {
    const origin = req.headers.get("origin")?.toLowerCase();
    const referer = req.headers.get("referer")?.toLowerCase();
    const matchesOrigin = !!origin && origin === expectedOrigin;
    const matchesReferer = !origin && !!referer && referer.startsWith(expectedOrigin);
    if (!matchesOrigin && !matchesReferer) {
      audit({ action: "connect", ip, ok: false, errCode: "BAD_ORIGIN" });
      return jsonError("FORBIDDEN", "Bad origin", 403);
    }
  }

  const session = await auth();
  if (!session?.user) {
    audit({ action: "connect", ip, ok: false, errCode: "UNAUTH" });
    return jsonError("UNAUTH", "Sign-in required", 401);
  }
  const email = session.user.email ?? "unknown";

  // Per-user rate limit: 10 attempts / minute.
  const rl = await rateLimit(`connect:${email}`, 10, 60_000);
  if (!rl.ok) {
    audit({ action: "connect", email, ip, ok: false, errCode: "RATE_LIMIT", ms: Date.now() - t0 });
    return jsonError("RATE_LIMIT", "Too many requests", 429, { "Retry-After": String(rl.retryAfter) });
  }

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
