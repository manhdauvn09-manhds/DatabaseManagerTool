# Software Requirements Specification
## DatabaseManager — Secure Connect (v2)

**Version:** 2.1  
**Date:** 2026-07-21  
**Status:** Baseline

---

## 1. Overview

DatabaseManager is a multi-tenant web application that allows authorized users to connect to and manage relational databases through a browser UI. Users authenticate via Google OAuth before accessing any functionality. Database passwords are never stored server-side beyond an in-memory session; client-side RSA encryption provides defense-in-depth over the wire.

---

## 2. Users and Roles

| Role | Description |
|------|-------------|
| **Authenticated User** | Any Google account that passes the email/domain allowlist. Can create DB connections, run queries, and manage saved connection profiles. |
| **Unauthenticated Visitor** | Can access only `/`, `/signin`, and `/api/health`. All other routes are gated. |
| **Operator / Admin** | Configures environment variables and manages the deployment. No in-app admin UI exists. |

---

## 3. Functional Requirements

### Authentication

| ID | Requirement |
|----|-------------|
| FR-001 | The system shall require Google OAuth sign-in before granting access to `/app/*` or any `/api/*` route (except `/api/auth/*` and `/api/health`). |
| FR-002 | Sign-in shall be fail-closed: if neither `ALLOWED_EMAILS` nor `ALLOWED_EMAIL_DOMAINS` is configured and `AUTH_ALLOW_ANY` is not `true`, all sign-in attempts shall be rejected. |
| FR-003 | The system shall support an email allowlist (`ALLOWED_EMAILS`) and domain allowlist (`ALLOWED_EMAIL_DOMAINS`); a matching account on either list shall be permitted. |
| FR-004 | Sessions shall be JWT-based with a configurable maximum age (default 24 hours, minimum 60 seconds). |
| FR-005 | Sign-in and sign-out events shall be written to the structured audit log. |

### Database Connection

| ID | Requirement |
|----|-------------|
| FR-006 | The system shall expose `GET /api/crypto/public-key` which returns an RSA-OAEP public key (JWK format) and a `keyId`. |
| FR-007 | The client shall encrypt the database password with the public key using RSA-OAEP (SHA-256) via the browser WebCrypto API before transmitting it. |
| FR-008 | The system shall expose `POST /api/connect` which accepts `dbType`, `host`, `port`, `user`, `passwordEncrypted`, and `keyId`, decrypts the password server-side, and tests the connection. |
| FR-009 | On successful connection test, the system shall return a `connectionId` with the resolved `dbType`. The `connectionId` shall be valid for a configurable TTL (default 30 minutes, sliding, hard cap 2 hours). |
| FR-010 | The system shall support database types: MySQL, PostgreSQL, and MSSQL. A `dbType` value of `auto` shall trigger port-based detection. |
| FR-011 | On `keyId` mismatch (stale key), the server shall return `409 KEY_ROTATED`; the client shall re-fetch the public key and retry. |

### Saved Connection Profiles

| ID | Requirement |
|----|-------------|
| FR-012 | The system shall allow authenticated users to save named connection profiles (host, port, user, dbType) encrypted at rest. |
| FR-013 | Saved profiles shall be stored in a JSON file at the path configured by `SAVED_CONNECTIONS_PATH` (default `/data/saved-connections.json`). |
| FR-014 | Each profile shall be encrypted using a per-user AES-256-GCM key derived from `VAULT_MASTER_SECRET` via HKDF-SHA-256 with the user's email hash as key-material context. |
| FR-015 | If `VAULT_MASTER_SECRET` is not configured, `/api/saved-connections` shall return `503`. |
| FR-016 | The system shall support zero-downtime key rotation: `VAULT_MASTER_SECRET_OLD` allows decryption of profiles encrypted under the previous key during transition. |

### Health and Observability

| ID | Requirement |
|----|-------------|
| FR-017 | `GET /api/health` shall be publicly accessible (no auth), return `{ ok: true, ts: "<ISO timestamp>" }` with HTTP 200, and never expose secrets or internal state. |
| FR-018 | All `POST /api/connect` attempts shall be written to the audit log regardless of outcome, including fields: `ts`, `action`, `email`, `ip`, `host`, `port`, `dbType`, `ok`, `errCode`, `ms`. |
| FR-019 | The audit log shall never include `password`, `passwordEncrypted`, or `keyId`. |

### AI SQL Assistant (Optional)

| ID | Requirement |
|----|-------------|
| FR-020 | When `AI_SQL_BASE_URL` and `AI_SQL_API_KEY` are configured, the system shall provide a natural-language-to-SQL feature in the SQL editor. |
| FR-021 | When the AI SQL variables are not set, the UI shall hide the AI input and the feature shall be entirely inactive. |

---

## 4. Non-Functional Requirements

### Security

| ID | Requirement |
|----|-------------|
| NFR-001 | All production traffic shall use HTTPS/TLS; HTTP shall not be used in production. |
| NFR-002 | The system shall block connections to loopback addresses (127.0.0.0/8), link-local (169.254.0.0/16), cloud metadata ranges, multicast, and reserved ranges unconditionally (SSRF guard). |
| NFR-003 | Connections to private/LAN address space (RFC 1918) shall be blocked by default; enabled only when `ALLOW_PRIVATE_HOSTS=true`. |
| NFR-004 | DNS resolution shall validate all returned addresses against the blocklist (defense against DNS-rebinding). |
| NFR-005 | Database passwords shall never be persisted to disk, logs, or any client-side storage (localStorage, sessionStorage, cookies). |
| NFR-006 | The server shall zero out decrypted passwords from memory after use. |
| NFR-007 | Driver-level error messages shall never be forwarded to the client; only a generic `"Unable to connect to database"` message shall be returned. |
| NFR-008 | When `REQUIRE_CLOUDFLARE=true`, any request missing the `CF-Connecting-IP` header shall be rejected. |

### Performance and Reliability

| ID | Requirement |
|----|-------------|
| NFR-009 | Each database driver shall apply a connect timeout of 5000 ms; a server-side watchdog shall terminate hangs within 5500 ms. |
| NFR-010 | The system shall enforce a global concurrent-connect cap (`DB_MAX_CONCURRENT_CONNECTS`, default 10) and a per-user cap (`DB_MAX_PER_USER_CONNECTS`, default 2). |
| NFR-011 | `/api/connect` shall enforce a rate limit of 10 requests per minute per authenticated email. |
| NFR-012 | `/api/crypto/public-key` shall enforce a rate limit of 30 requests per minute per client IP. |
| NFR-013 | Request body size for `/api/connect` shall be capped at 4096 bytes; requests over this limit shall receive HTTP 413. |
| NFR-014 | The route maximum execution time (`maxDuration`) shall be 15 seconds. |

### Correctness and Validation

| ID | Requirement |
|----|-------------|
| NFR-015 | All connection request fields shall be validated via a Zod schema: `dbType` must be an enum, `host` must match `[a-zA-Z0-9.\-:\[\]]+` (max 253 chars), `port` must be 1–65535, `user` max 128 chars, `passwordEncrypted` max 1024 chars, `keyId` max 128 chars. |

### Build Quality Gate

| ID | Requirement |
|----|-------------|
| NFR-016 | The Dockerfile build stage shall run `npm run test` (vitest) before `npm run build`. A failing test shall abort the Docker build and therefore the deploy. |

---

## 5. Constraints

- **Authentication provider:** Google OAuth only (NextAuth.js).
- **Runtime:** Node.js (Next.js App Router, `runtime = "nodejs"`).
- **Deployment:** Docker container, reverse-proxied by host Nginx with TLS termination.
- **Data volume:** Saved connections and the RSA keypair persist on a Docker volume (`/data`). The volume must not be recreated — it holds all user-saved connection profiles.
- **Redis (optional):** When `REDIS_URL` is set and `VAULT_MASTER_SECRET` is configured, shared state (rate limits, connection records) moves to Redis, enabling multi-instance deployments.

---

## 6. Out of Scope

- In-app admin console or user management UI.
- Direct browser-to-database connectivity (all DB connections are server-side).
- Database write operations initiated directly from a scheduled or automated context (no cron/batch queries).
- LDAP, SAML, or non-Google identity providers.
- Storage of query history or result sets server-side.
- Schema migration or DDL execution tooling.
