# Security & Privacy Spec — DatabaseManager (v2.1)

## Authentication
- Google sign-in required for `/app/*` and all `/api/*` except `/api/auth/*` and `/api/health`.
- **Email allowlist (fail-closed)**: `ALLOWED_EMAILS` and/or `ALLOWED_EMAIL_DOMAINS` env vars MUST be set, otherwise sign-in is rejected. Dev override: `AUTH_ALLOW_ANY=true`.
- `/api/*` returns `401 UNAUTH` JSON when unauthenticated; `/app/*` redirects to `/signin`.

## Transport
- Production MUST use HTTPS/TLS.
- Origin firewall MUST restrict inbound 80/443 to Cloudflare IP ranges only — see `setup-cloudflare-firewall.sh`.
- `REQUIRE_CLOUDFLARE=true` in env rejects any request reaching the origin without `CF-Connecting-IP` header (defense-in-depth alongside firewall).

## Network egress / SSRF
- All connect targets pass through `ensureSafeHost()` (`src/lib/security/ssrfGuard.ts`).
- **Always blocked** (no override): 127.0.0.0/8, 169.254.0.0/16 (AWS/GCE metadata), 0.0.0.0/8, 224.0.0.0/4, 240.0.0.0/4, `::1`, IPv4-mapped IPv6 of the above.
- **Blocked unless `ALLOW_PRIVATE_HOSTS=true`**: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fe80::/10.
- Hostnames resolved via DNS; ALL returned addresses checked (defense against DNS-based bypass).

## Defense-in-depth (Client-side encryption)
- FE fetches `GET /api/crypto/public-key` (auth-required, rate-limited 30/min/IP) and encrypts password with RSA-OAEP SHA-256 (2048-bit) using WebCrypto.
- API decrypts using in-memory private key.
- On `keyId` mismatch → `409 KEY_ROTATED`; client refetches and retries.

## Rate limits
- `/api/connect`: 10 requests / minute / authenticated email.
- `/api/crypto/public-key`: 30 requests / minute / client IP (CF-Connecting-IP preferred, X-Forwarded-For fallback).

## Input validation
- Zod `ConnectRequestSchema`: dbType enum, host regex `[a-zA-Z0-9.\-:[\]]+` (max 253), port 1..65535, user max 128 chars, passwordEncrypted max 1024 chars, keyId max 128 chars.
- Request body hard cap: 4096 bytes (over → 413).
- Route `maxDuration = 15s`.

## DB connection hardening
- Per-driver connect timeout: 5000ms (mysql2 `connectTimeout`, pg `connectionTimeoutMillis`, mssql `connectionTimeout`).
- Plus `Promise.race` watchdog with +500ms margin to break hangs that bypass driver timeout.
- MSSQL TLS: `encrypt=true`, `trustServerCertificate=false` by default. Override only via `MSSQL_TRUST_SERVER_CERT=true` env (per-deployment).

## Error handling / information disclosure
- `/api/connect` returns generic message `"Unable to connect to database"` to client on driver failure.
- Driver error string logged server-side via `console.error` only; never sent to client; never in audit log.
- No stack traces leaked.

## Secret handling
- No password stored in localStorage/sessionStorage.
- FE clears password from React state immediately after encryption.
- Server stores decrypted password in-memory only (TTL 30 min, Map-based) and zeroes local variable after use.
- Never logs secrets. Audit log uses an allowlist of fields — extra keys silently dropped.
- Generated `AUTH_SECRET` must be random base64; never reused across environments.

## Audit logging
- Structured JSON to stdout (Docker logs picked up by host log aggregator).
- Fields: `ts, action, email, ip, host, port, dbType, ok, errCode, ms`.
- Forbidden fields enforced by allowlist: `password`, `passwordEncrypted`, `keyId`.
- Captured events: every `connect` attempt, including UNAUTH/RATE_LIMIT/BODY_TOO_LARGE/BAD_REQUEST/HOST_BLOCKED/KEY_ROTATED/DECRYPT_FAIL/BAD_PASSWORD/CONNECT_FAIL/OK.

## Key rotation
- Server keypair is ephemeral (in-memory). Restart → rotation → client receives `409 KEY_ROTATED`.
- Multi-instance production: replace with stable KMS/HSM-managed keypair.

## Tests (vitest)
- `src/lib/security/__tests__/ssrfGuard.test.ts`
- `src/lib/security/__tests__/rateLimit.test.ts`
- `src/lib/security/__tests__/auditLog.test.ts`
- `src/lib/schemas/__tests__/connect.test.ts`
- Gate: Dockerfile `builder` stage runs `npm run test` before `npm run build`. A failing test fails the deploy.
