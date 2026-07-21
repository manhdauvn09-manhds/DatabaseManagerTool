# Architecture & Design Specification
## DatabaseManager — Secure Connect (v2)

**Version:** 2.1  
**Date:** 2026-07-21  
**Status:** Baseline

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLIENT (Browser)                        │
│                                                                   │
│  ┌──────────────┐   WebCrypto (RSA-OAEP)   ┌─────────────────┐  │
│  │   React UI   │ ──────────────────────── │ passwordEncrypted│  │
│  └──────┬───────┘                           └────────┬────────┘  │
│         │  HTTPS                                     │ HTTPS      │
└─────────┼───────────────────────────────────────────┼────────────┘
          │                                            │
┌─────────▼───────────────────────────────────────────▼────────────┐
│                   HOST NGINX (TLS termination)                     │
│                   Cloudflare CDN / IP firewall                     │
└─────────────────────────────────┬────────────────────────────────┘
                                  │ HTTP :9230
┌─────────────────────────────────▼────────────────────────────────┐
│                   DOCKER: dbmanager-app                            │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                   Next.js App Router (Node.js)               │ │
│  │                                                              │ │
│  │  /api/health          → Public liveness probe               │ │
│  │  /api/auth/*          → NextAuth.js (Google OAuth)          │ │
│  │  /api/crypto/public-key → RSA keypair (in-memory)           │ │
│  │  /api/connect         → Decrypt, SSRF guard, DB test        │ │
│  │  /api/saved-connections → Vault CRUD (AES-256-GCM)          │ │
│  │  /app/*               → Protected UI pages                  │ │
│  │                                                              │ │
│  │  lib/security/ssrfGuard   lib/security/rateLimit            │ │
│  │  lib/security/auditLog    lib/schemas/connect               │ │
│  │  lib/crypto/serverVault   lib/connections/store             │ │
│  └─────────────────────────────────┬────────────────────────────┘ │
│                                    │                               │
│  ┌─────────────────────────────────▼────────────────────────────┐ │
│  │  Docker Volume: /data                                         │ │
│  │   saved-connections.json  (AES-256-GCM blobs, per-user key)  │ │
│  │   server-keypair.json     (RSA keypair, vault-encrypted)      │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  DOCKER: dbmanager-redis  (optional shared state)             │ │
│  │   Rate limit counters  │  Connection records (vault-encrypted)│ │
│  └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
          │ TCP (DB protocol)
          ▼
   External Database (MySQL / PostgreSQL / MSSQL)
```

---

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 14+ (App Router, server components) |
| Runtime | Node.js (all API routes use `runtime = "nodejs"`) |
| Auth | NextAuth.js v5 — Google OAuth 2.0, JWT sessions |
| DB drivers | `mysql2`, `pg`, `mssql` |
| Validation | Zod |
| Encryption (client) | WebCrypto API — RSA-OAEP SHA-256 |
| Encryption (server) | Node.js `crypto` — AES-256-GCM, HKDF-SHA-256 |
| State (optional) | Redis via `ioredis` |
| Containerization | Docker Compose |
| Reverse proxy | Host Nginx (TLS termination, vhost already configured) |
| CDN / WAF | Cloudflare (IP allowlisting at firewall level) |
| Tests | Vitest |

---

## 3. Key Components

### API Routes

| Route | Auth | Description |
|-------|------|-------------|
| `GET /api/health` | None | Public liveness probe. Returns `{ ok, ts }`. Used by Docker HEALTHCHECK and uptime monitors. |
| `GET /api/auth/*` | None | NextAuth.js OAuth callback and session endpoints. |
| `GET /api/crypto/public-key` | Required | Returns `{ keyId, publicJwk }`. Rate-limited 30/min/IP. |
| `POST /api/connect` | Required | Decrypts password, validates input via Zod, runs SSRF guard, tests DB connection, returns `{ connectionId, dbType }`. Rate-limited 10/min/email. |
| `GET /api/saved-connections` | Required | Lists the calling user's saved connection profiles (decrypted from vault). Returns 503 if vault is not configured. |
| `POST /api/saved-connections` | Required | Creates or updates a saved connection profile; encrypts via server vault. |
| `DELETE /api/saved-connections/[id]` | Required | Deletes a saved profile. |

### Library Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| `auth` | `src/auth.ts` | NextAuth configuration: Google provider, JWT strategy, email allowlist callback, audit events. |
| `ssrfGuard` | `src/lib/security/ssrfGuard.ts` | Validates target host/IP against blocked ranges before any outbound DB connection. DNS-resolves hostnames and checks all returned addresses. |
| `rateLimit` | `src/lib/security/rateLimit.ts` | Sliding-window rate limiter backed by Redis (when available) or in-memory Map. |
| `auditLog` | `src/lib/security/auditLog.ts` | Structured JSON logging to stdout with field allowlist (drops any field not in the approved set). |
| `serverVault` | `src/lib/crypto/serverVault.ts` | AES-256-GCM at-rest encryption for saved profiles. Derives per-user key via HKDF. Supports key rotation via primary + optional legacy master. |
| `connections/store` | `src/lib/connections/store.ts` | In-memory (or Redis-backed) map of active `connectionId` records. Sliding TTL, hard session cap, oldest-eviction on overflow. Zeroes passwords on eviction/shutdown. |
| `schemas/connect` | `src/lib/schemas/connect.ts` | Zod schema for `POST /api/connect` request body. |

---

## 4. Data Flow — Auth → Decrypt → DB → Response

```
1. User visits /app/*
   └─ Middleware checks NextAuth session cookie
       ├─ No session → redirect to /signin
       └─ Valid session → continue

2. Client fetches GET /api/crypto/public-key
   └─ Server returns { keyId, publicJwk } (in-memory RSA-OAEP 2048-bit keypair)

3. Client encrypts DB password in browser (WebCrypto, RSA-OAEP SHA-256)
   └─ Result: base64 passwordEncrypted

4. Client sends POST /api/connect
   { dbType, host, port, user, passwordEncrypted, keyId }
   │
   ├─ [A] Session check → 401 if not authenticated
   ├─ [B] Body size check → 413 if > 4096 bytes
   ├─ [C] Rate limit check (10/min/email) → 429 if exceeded
   ├─ [D] Zod schema validation → 400 if invalid
   ├─ [E] keyId match check → 409 KEY_ROTATED if stale
   ├─ [F] RSA decrypt passwordEncrypted → plaintext password (in memory only)
   ├─ [G] ensureSafeHost(host) → 403 HOST_BLOCKED if private/reserved
   ├─ [H] Driver connect (mysql2 / pg / mssql) with 5s timeout + watchdog
   │       ├─ Success → driver disconnects
   │       └─ Failure → generic error to client; driver error logged server-side
   ├─ [I] createConnectionRecord() → stores { id, ownerEmail, host, port,
   │       dbType, password, resolvedIp, expiresAt } in memory (or Redis+vault)
   ├─ [J] Zero local password variable
   ├─ [K] Audit log entry written
   └─ [L] Return { connectionId, dbType } to client

5. Client uses connectionId for subsequent query/browse API calls
   └─ getConnectionRecord(id, ownerEmail) validates ownership + slides TTL
```

---

## 5. Security Design

### 5.1 Authentication — Email Allowlist (Fail-Closed)

NextAuth uses a `signIn` callback that evaluates `ALLOWED_EMAILS` and `ALLOWED_EMAIL_DOMAINS`. If neither variable contains any values and `AUTH_ALLOW_ANY` is not `true`, the callback returns `false` and Google OAuth is blocked at the application level, regardless of which Google account the user holds.

### 5.2 Client-Side Encryption (Defense-in-Depth)

The browser fetches the server's RSA-OAEP public key and encrypts the database password before the POST request leaves the device. This means that even if TLS were somehow stripped in transit, the raw password would not be exposed. HTTPS remains the primary transport security layer.

### 5.3 Server Vault — AES-256-GCM at Rest

Saved connection profiles are encrypted before being written to disk using the following key-derivation scheme:

```
VAULT_MASTER_SECRET (base64, ≥32 bytes)
        │
        └─ HKDF-SHA-256(master, per-blob salt, info=email-hash)
                │
                └─ 256-bit AES key  →  AES-256-GCM(plaintext, per-blob IV)
                                        → { salt, iv, ciphertext+tag, v }
```

Key rotation is zero-downtime: set `VAULT_MASTER_SECRET_OLD` to the outgoing key while setting a new `VAULT_MASTER_SECRET`. Existing blobs decrypt via the old key; re-saving migrates them to the new key. Each blob carries a short fingerprint `v` of the encrypting key to guide decryption without a trial-and-error loop.

### 5.4 SSRF Guard

`ensureSafeHost()` resolves the target hostname via DNS and checks every returned IP address against blocked CIDR ranges before the database driver opens a socket. Always-blocked ranges include loopback, link-local (cloud metadata), unspecified, multicast, and reserved. Private RFC 1918 ranges are blocked by default and require `ALLOW_PRIVATE_HOSTS=true` to permit. MSSQL connections bind to the SSRF-validated resolved IP rather than the hostname, preventing DNS-rebinding attacks mid-connect.

### 5.5 Rate Limiting

| Endpoint | Limit | Key |
|----------|-------|-----|
| `POST /api/connect` | 10 req/min | Authenticated email |
| `GET /api/crypto/public-key` | 30 req/min | `CF-Connecting-IP` or `X-Forwarded-For` |

When Redis is available, counters are shared across instances. Without Redis, per-instance in-memory Maps are used (multi-instance deployments will have independent counters per node).

### 5.6 Information Disclosure Prevention

- Driver-level errors are logged server-side only (`console.error`); the client always receives the generic message `"Unable to connect to database"`.
- No stack traces are included in error responses.
- The audit log enforces a field allowlist; any extra key is silently dropped, preventing accidental logging of `password`, `passwordEncrypted`, or `keyId`.

### 5.7 In-Memory Password Lifecycle

```
decrypt → store in ConnectionRecord.password (Map or Redis encrypted via vault)
        → zero local variable after store
        → TTL eviction zeroes password field before Map.delete()
        → SIGTERM/SIGINT handler zeroes all in-memory records
```

Passwords are never written to disk in plaintext. When Redis is the backend, the password is vault-encrypted before serialization.

### 5.8 RSA Keypair Lifecycle

The RSA-OAEP 2048-bit keypair is generated at process startup and kept in memory. When `SERVER_KEYPAIR_PATH` and `VAULT_MASTER_SECRET` are both set, the keypair is persisted to disk encrypted via the vault (so restarts do not rotate the key and produce `409 KEY_ROTATED` for active clients). Without these settings the keypair is ephemeral — a restart or deployment triggers key rotation. Multi-instance production environments should use a KMS/HSM-managed keypair.

---

## 6. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_GOOGLE_ID` | Yes | — | Google OAuth 2.0 client ID |
| `AUTH_GOOGLE_SECRET` | Yes | — | Google OAuth 2.0 client secret |
| `AUTH_SECRET` | Yes | — | Random base64 string for NextAuth JWT signing. Generate: `openssl rand -base64 32` |
| `AUTH_URL` | Yes (prod) | — | Public URL of the app. Must match the URL users access. |
| `AUTH_TRUST_HOST` | No | `false` | Set `true` when behind a reverse proxy. |
| `ALLOWED_EMAILS` | See note | — | Comma-separated list of allowed Google email addresses. |
| `ALLOWED_EMAIL_DOMAINS` | See note | — | Comma-separated list of allowed email domains (e.g. `example.com`). |
| `AUTH_ALLOW_ANY` | No | `false` | Dev/staging override — allow any Google account. Never use in production. |
| `REQUIRE_CLOUDFLARE` | No | `false` | Reject requests missing `CF-Connecting-IP` (use with IP firewall). |
| `ALLOW_PRIVATE_HOSTS` | No | `false` | Allow DB connections to RFC 1918 addresses. |
| `MSSQL_TRUST_SERVER_CERT` | No | `false` | Trust self-signed MSSQL TLS certificates. |
| `DB_SSL_STRICT` | No | `false` | Full chain TLS verification for MySQL/PostgreSQL. |
| `SESSION_MAXAGE_SEC` | No | `86400` | Session cookie lifetime in seconds (min 60). |
| `DB_MAX_CONCURRENT_CONNECTS` | No | `10` | Global cap on simultaneous DB test connects. |
| `DB_MAX_PER_USER_CONNECTS` | No | `2` | Per-user fairness cap on simultaneous DB test connects. |
| `DB_POOL_ENABLED` | No | `false` | Enable driver-handle pooling per connectionId. |
| `DB_POOL_IDLE_MS` | No | `30000` | Idle eviction timeout for pooled connections (ms). |
| `CONNECTION_TTL_MS` | No | `300000` | Sliding TTL for connectionId records (ms, min 60 000). |
| `CONNECTION_MAX_RECORDS` | No | `1000` | In-memory connection record cap; oldest evicted on overflow. |
| `SAVED_CONNECTIONS_PATH` | No | `/data/saved-connections.json` | Path to the encrypted saved-connections file. |
| `VAULT_MASTER_SECRET` | Required for saved profiles | — | Base64 ≥32 bytes. Derives AES-256-GCM keys for saved profile encryption. |
| `VAULT_MASTER_SECRET_OLD` | No | — | Previous master key, decrypt-only, during key rotation. |
| `SERVER_KEYPAIR_PATH` | No | `/data/server-keypair.json` | Persisted RSA keypair path (vault-encrypted). Unset = ephemeral. |
| `REDIS_URL` | No | — | Redis connection URL. Enables shared rate-limit and connection-record state. |
| `REDIS_PREFIX` | No | `dbm:` | Key prefix for all Redis keys. |
| `NEXT_PUBLIC_APP_NAME` | No | `DatabaseManager` | App display name in the UI. |
| `AI_SQL_BASE_URL` | No | — | Base URL of an OpenAI-compatible API for the SQL assistant feature. |
| `AI_SQL_API_KEY` | No | — | API key for the AI SQL assistant endpoint. |
| `AI_SQL_MODEL` | No | `deepseek-chat` | Model identifier for the AI SQL assistant. |

> **Note on allowlist:** At least one of `ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS` must be set in production, or `AUTH_ALLOW_ANY=true` for development. Leaving all three unset causes all sign-in attempts to be rejected.

---

## 7. Deployment

### Container Layout

```
docker-compose
├── dbmanager-app   (Next.js, port 9230)
│    └── /data volume: saved-connections.json, server-keypair.json
└── dbmanager-redis (Redis with AOF persistence)
     └── dbmanager_dbmanager_redis volume
```

### Deploy Procedure

Deployment is triggered via the MCP `deploy` tool with `{ server_id: "mcp-80", app_id: "dbmanager" }`. This runs:

```
docker compose build --no-cache app
docker compose up -d app
```

The `redis` container is never touched during deploys. Both volumes (`dbmanager_dbmanager_data`, `dbmanager_dbmanager_redis`) must never be recreated — they hold all user-saved connection profiles and Redis session/cache state respectively.

### Build Quality Gate

The Dockerfile `builder` stage runs `npm run test` (vitest) before `npm run build`. A test failure aborts the image build, preventing broken code from reaching production.

### Production Hardening Checklist

- [ ] Nginx vhost configured with TLS (Let's Encrypt wildcard `allin1site-wildcard`).
- [ ] Cloudflare proxy enabled; iptables/ufw restricts inbound 443 to Cloudflare IP ranges.
- [ ] `REQUIRE_CLOUDFLARE=true` set in env.
- [ ] `VAULT_MASTER_SECRET` set to a random base64 ≥32-byte value.
- [ ] `AUTH_ALLOW_ANY` is `false` (or absent).
- [ ] `ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS` configured.
- [ ] `AUTH_SECRET` is unique to this environment (not reused from staging/dev).
- [ ] Redis running and `REDIS_URL` configured for multi-instance or restart-survivable rate limits.
