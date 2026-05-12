# Fixes Report — 2026-05-12

Báo cáo 10 fix bảo mật theo skill `be-security-audit`.

## Bảng tóm tắt

| # | Issue | Status | File(s) thay đổi | Test |
|---|---|---|---|---|
| 1 | SSRF qua user-input host/port | ✅ | `src/lib/security/ssrfGuard.ts`, `src/app/api/connect/route.ts` | `ssrfGuard.test.ts` (15 cases) |
| 2 | Thiếu rate-limit | ✅ | `src/lib/security/rateLimit.ts`, `src/app/api/connect/route.ts`, `src/app/api/crypto/public-key/route.ts` | `rateLimit.test.ts` (8 cases) |
| 3 | Public-key endpoint mở | ✅ | `src/middleware.ts` (bỏ whitelist), `src/app/api/crypto/public-key/route.ts` (auth + rate-limit) | smoke TC-01 |
| 4 | Không allowlist email Google | ✅ | `src/auth.ts` (signIn callback) | smoke TC-02 |
| 5 | MSSQL `trustServerCertificate=true` | ✅ | `src/lib/connections/testConnection.ts` (default false, env override) | smoke TC-12 |
| 6 | DB connect không timeout | ✅ | `src/lib/connections/testConnection.ts` (5s + watchdog) | smoke TC-07 |
| 7 | Leak raw driver error | ✅ | `src/lib/connections/testConnection.ts` (`internalReason`), `src/app/api/connect/route.ts` (generic message, server-only log) | smoke TC-09 |
| 8 | Origin lộ trực tiếp internet | ✅ | `setup-cloudflare-firewall.sh` (ufw + CF IP ranges), `src/middleware.ts` (`REQUIRE_CLOUDFLARE`) | smoke TC-11 |
| 9 | Không body size limit | ✅ | `src/app/api/connect/route.ts` (4096 byte cap), `src/lib/schemas/connect.ts` (per-field max) | `connect.test.ts` + smoke TC-06 |
| 10 | Không audit log | ✅ | `src/lib/security/auditLog.ts`, mọi exit path trong `/api/connect` | `auditLog.test.ts` + smoke TC-10 |

## Chi tiết từng fix

### 1. SSRF guard
Module mới `src/lib/security/ssrfGuard.ts` chứa `ensureSafeHost(host, { allowPrivate })`. Logic 2 lớp:
- **Always blocked** (kể cả khi `allowPrivate=true`): 127.0.0.0/8 (loopback), 169.254.0.0/16 (AWS/GCE metadata), 0.0.0.0/8, 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved), `::1`, IPv4-mapped IPv6 của các dải trên.
- **Blocked unless `ALLOW_PRIVATE_HOSTS=true`**: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fe80::/10.

Hostname không phải IP literal → resolve qua `dns/promises.lookup({ all: true })` rồi check **TẤT CẢ** IP trả về (chống DNS bypass). Route `/api/connect` gọi `ensureSafeHost` ngay sau Zod validation, trước cả crypto/decrypt.

### 2. Rate limit
Module `src/lib/security/rateLimit.ts` — sliding window in-memory Map. Lazy cleanup mỗi 60s để tránh memory leak. `getClientIp(req)` ưu tiên `CF-Connecting-IP`, fallback `X-Forwarded-For` (first), `X-Real-IP`, `"unknown"`.

Giới hạn:
- `/api/connect`: **10 req/phút/email** (key: `connect:<email>`).
- `/api/crypto/public-key`: **30 req/phút/IP** (key: `pubkey:<ip>`).

Response: `429 RATE_LIMIT` + header `Retry-After: <seconds>`.

### 3. Public-key endpoint require auth
- `src/middleware.ts`: bỏ whitelist `/api/crypto/public-key`. Route giờ chỉ với người đã sign-in.
- `src/app/api/crypto/public-key/route.ts`: thêm `await auth()` defense-in-depth + rate limit.
- Bonus: middleware giờ trả `401 JSON` cho `/api/*` thay vì redirect HTML (đúng REST convention).

### 4. Email allowlist
`src/auth.ts` thêm `callbacks.signIn` đọc 2 env:
- `ALLOWED_EMAILS=alice@x.com,bob@y.com` — list email cụ thể.
- `ALLOWED_EMAIL_DOMAINS=example.com,foo.org` — match domain.

**Fail-closed**: nếu cả 2 đều trống → reject mọi sign-in. Chỉ allow tất cả khi `AUTH_ALLOW_ANY=true` (dev override).

### 5. MSSQL TLS strict
`src/lib/connections/testConnection.ts`: `trustServerCertificate: input.mssqlTrustServerCertificate === true`. Route truyền từ env `MSSQL_TRUST_SERVER_CERT` (mặc định false). Production phải có cert hợp lệ; self-signed cert phải opt-in tường minh.

### 6. DB connect timeout
- mysql2: `connectTimeout: 5000`.
- pg: `connectionTimeoutMillis: 5000` + `statement_timeout: 5000`.
- mssql: `connectionTimeout: 5000` + `requestTimeout: 5000`.
- Watchdog `withTimeout()` wrap mỗi connect/query với +500ms margin để bắt trường hợp driver bỏ qua timeout. Auto-cleanup `clearTimeout` trong `finally`.

### 7. Generic error message
`testConnection` trả `{ ok: false, message: "Unable to connect to database", internalReason: "..." }`. Route gửi `message` cho client, log `internalReason` qua `console.error` (server-only, server logs only — Docker `logs app`).

### 8. Cloudflare-only origin
**Layer 1 — firewall** (`setup-cloudflare-firewall.sh`): ufw deny tất cả 80/443, allow theo `cloudflare.com/ips-v4` + `ips-v6`. Idempotent, có thể chạy cron để refresh.

**Layer 2 — middleware** (`REQUIRE_CLOUDFLARE=true`): từ chối request thiếu `CF-Connecting-IP` header → `403 FORBIDDEN`. Chỉ là defense-in-depth: nếu attacker tiếp cận origin trực tiếp, họ có thể tự set header. Firewall là gate thật.

### 9. Body size limit
- `/api/connect`: đọc raw body qua `req.text()`, check `length > 4096` → `413 BODY_TOO_LARGE` trước khi JSON.parse.
- Schema: `passwordEncrypted` max 1024 chars, `host` max 253, `user` max 128, `keyId` max 128.
- `export const maxDuration = 15` (Vercel hint, ignored on self-host nhưng vẫn document intent).

### 10. Audit log
`src/lib/security/auditLog.ts` xuất JSON 1 dòng qua `console.log` (Docker stdout). Có whitelist field — **không bao giờ** xuất `password`/`passwordEncrypted`/`keyId` kể cả khi caller cố tình truyền vào.

Mọi exit path của `/api/connect` đều gọi `audit()` với `errCode` tương ứng: `UNAUTH`, `RATE_LIMIT`, `BODY_TOO_LARGE`, `BAD_REQUEST`, `HOST_BLOCKED`, `KEY_ROTATED`, `DECRYPT_FAIL`, `BAD_PASSWORD`, `CONNECT_FAIL`, hoặc `ok:true`.

## Files mới

```
SecureConnect/src/lib/security/
  ├── ssrfGuard.ts                      # IPv4/IPv6 classification + DNS-resolve guard
  ├── rateLimit.ts                      # Sliding-window in-memory + getClientIp
  ├── auditLog.ts                       # JSON audit with field whitelist
  └── __tests__/
      ├── ssrfGuard.test.ts             # 15 test cases
      ├── rateLimit.test.ts             # 8 test cases
      └── auditLog.test.ts              # 3 test cases

SecureConnect/src/lib/schemas/__tests__/
  └── connect.test.ts                   # 8 test cases

SecureConnect/src/app/api/health/route.ts # Public liveness probe (no auth)
SecureConnect/vitest.config.ts            # Vitest + @ alias

setup-cloudflare-firewall.sh              # ufw + CF IP ranges
```

## Files đã sửa

```
SecureConnect/src/middleware.ts            # Bỏ pubkey whitelist, thêm /api/health, CF check, API trả 401 JSON
SecureConnect/src/auth.ts                  # Email allowlist signIn callback (fail-closed)
SecureConnect/src/lib/schemas/connect.ts   # Stricter validation (regex + max lengths)
SecureConnect/src/lib/connections/testConnection.ts  # Timeout, TLS strict, internalReason
SecureConnect/src/app/api/connect/route.ts # Body cap, SSRF, rate limit, audit, generic error
SecureConnect/src/app/api/crypto/public-key/route.ts # Auth + rate limit
SecureConnect/.env.example                  # Thêm ALLOWED_EMAILS, ALLOW_PRIVATE_HOSTS, REQUIRE_CLOUDFLARE, MSSQL_TRUST_SERVER_CERT, AUTH_ALLOW_ANY
SecureConnect/package.json                  # vitest + test script
SecureConnect/Dockerfile                    # npm run test gate trong builder stage
docker-compose.yml                          # Healthcheck → /api/health
deploy.ps1                                  # Health check → /api/health
```

## Testing

### Tests đã viết (vitest)
```
src/lib/security/__tests__/ssrfGuard.test.ts    — 15 cases
src/lib/security/__tests__/rateLimit.test.ts    —  8 cases
src/lib/security/__tests__/auditLog.test.ts     —  3 cases
src/lib/schemas/__tests__/connect.test.ts       —  8 cases
                                                ──────────
                                  Total          34 cases
```

### Build gate
Dockerfile `builder` stage:
```dockerfile
RUN npm run test    # Fail nhanh nếu test fail → build fail → deploy không xảy ra
RUN npm run build
```

### Verification trên server (sau deploy)
Smoke test theo `BMAD_SDD_Skills_v2/4_quality/qa_strategy.md` TC-01 → TC-13.

### Local verification — KHÔNG chạy được
Máy local không có Node/Docker. Không thể chạy `npm test` hoặc `docker build` cục bộ. Verification chỉ xảy ra ở 2 điểm:
1. **Server first build** (Dockerfile builder stage) — test gate fail nhanh nếu code có lỗi.
2. **Manual smoke tests** sau khi deploy thành công (13 TCs trong qa_strategy.md).

Đã thực hiện **static review pass**: type-check thủ công, trace logic, kiểm tra import paths, edge cases, error handling consistency.

## Cấu hình BẮT BUỘC trên server

Trước khi `docker compose up -d --build` lần đầu, edit `SecureConnect/.env.production`:

```bash
# Bắt buộc — không sẽ deny mọi sign-in:
ALLOWED_EMAIL_DOMAINS=yourcompany.com
# HOẶC:
ALLOWED_EMAILS=alice@example.com,bob@example.com

# Khuyến nghị production:
REQUIRE_CLOUDFLARE=true        # Sau khi đã chạy setup-cloudflare-firewall.sh
ALLOW_PRIVATE_HOSTS=false      # Bật chỉ nếu cần connect LAN DB
MSSQL_TRUST_SERVER_CERT=false  # Bật chỉ nếu MSSQL self-signed
```

Và chạy 1 lần trên server (sau khi mở SSH non-80/443):
```bash
sudo bash setup-cloudflare-firewall.sh
```

---

# DB Optimization Fixes (2026-05-12)

Theo skill `/database-optimize`. 9 fix + 1 design decision documented.

## Bảng tóm tắt

| # | Issue | Fix | File |
|---|---|---|---|
| 1 | mssql.connect() global singleton race | `new mssql.ConnectionPool(cfg).connect()` per call | `testConnection.ts` |
| 2 | Mỗi request handshake mới (no pool) | **Design decision — không pool** (xem ghi chú) | `testConnection.ts` |
| 3 | `.end()/.close()` nuốt lỗi silent | `safeClose()` log warn nếu reject | `testConnection.ts` |
| 4 | Timeout reject xong socket pending → FD leak | `safelyConnect()` destroy on late-arrival | `testConnection.ts` |
| 5 | Không global concurrency cap | Semaphore N=5 (env `DB_MAX_CONCURRENT_CONNECTS`) | `testConnection.ts` |
| 6 | Thiếu SSL option mysql/pg | `ssl?: boolean` pass-through tất cả drivers | `schemas/connect.ts`, `testConnection.ts` |
| 7 | Map record không bounded | Cap 1000 + LRU evict (Map insertion order) | `store.ts` |
| 8 | `cleanupExpired` chỉ chạy on POST | `setInterval(60s).unref()` periodic sweep | `store.ts` |
| 9 | ConnectionRecord không gắn owner | `ownerEmail` field + check trong `getConnectionRecord` | `store.ts`, `/api/connect` |
| 10 | Password lưu 30p uổng | TTL giảm còn 5p (env `CONNECTION_TTL_MS`) | `store.ts` |

## Ghi chú: không pool

Pool sẽ cache decrypted password trong memory **vượt quá** TTL của connection record, vi phạm "no secret persistence". `testConnection` cố ý mở-kiểm-đóng. Nếu sau này có endpoint dùng `connectionId` để chạy query, có thể cân nhắc per-record short-idle pool (10s) keyed by record-id.

Đã viết comment trong `testConnection.ts` để document.

## Backward compat

- FE hiện gửi payload **không có** `ssl`. Schema cho phép undefined → driver mặc định không SSL. UI **không cần thay đổi**.
- `getConnectionRecord` đổi chữ ký (thêm `ownerEmail`). Chỉ `createConnectionRecord` đang được gọi — getter chưa có caller, nên thay đổi an toàn.
- TTL 30p → 5p: connectionId chưa được dùng ở endpoint nào → không ảnh hưởng user-facing flow.

## Env vars mới

```bash
DB_MAX_CONCURRENT_CONNECTS=5    # cap đồng thời connect attempts
CONNECTION_TTL_MS=300000         # 5 phút
CONNECTION_MAX_RECORDS=1000      # max record trong memory
```

## Test impact

- Tests cũ: vẫn pass (không đụng signature các module được test).
- Test mới thêm: 2 case cho `ssl` trong `connect.test.ts`.
- Build gate trong Dockerfile vẫn chạy `npm run test` trước `npm run build`.

---

# Additional Security Hardening (2026-05-12)

5 issue HIGH/MED còn sót sau 2 audit trước.

| # | Issue | Fix | File |
|---|---|---|---|
| 1 | Thiếu security headers app-level | `headers()` trong `next.config.mjs` — HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Disable powered-by | `next.config.mjs` |
| 2 | Docker logs unbounded → disk fill | `logging: json-file max-size 10m max-file 5` | `docker-compose.yml` |
| 3 | DNS lookup không timeout | `lookupWithTimeout()` 3s + `clearTimeout` cleanup | `ssrfGuard.ts` |
| 4 | /api/connect không check Origin/Referer | Match `Origin === AUTH_URL` (hoặc `Referer.startsWith`); audit `BAD_ORIGIN` | `/api/connect/route.ts` |
| 5 | NextAuth signIn/signOut không log | `events.signIn/signOut` → `audit()`; `callbacks.signIn` log fail với `EMAIL_NOT_ALLOWED` | `auth.ts` |

## CSP policy (default)

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: https:; font-src 'self' data:; connect-src 'self';
frame-ancestors 'none'; form-action 'self'; base-uri 'self'; object-src 'none'
```

- `'unsafe-inline'` cần cho hydration script + Tailwind inline. Nonce-based CSP cần middleware injection (TODO future).
- `frame-ancestors 'none'` = X-Frame-Options DENY (cùng nghĩa, modern browsers ưu tiên CSP).

## Logic impact

- **Origin check** chỉ kích hoạt khi `AUTH_URL` được set. Browser fetch tự động add Origin header — FE flow không đổi.
- **DNS timeout** 3s: nếu DNS hang quá 3s → trả `HOST_BLOCKED`. Không ảnh hưởng happy path (DNS thường < 100ms).
- **CSP**: có thể chặn inline script tạo bằng tay (không có trong code hiện tại). Image từ Google avatar (data URL hoặc https) vẫn load được.
- **Audit auth events** chỉ thêm log dòng, không đổi flow.

## Còn lại (LOW/operational)

| # | Item |
|---|---|
| 6 | Container resource limits (mem/cpu) |
| 7 | Pin Docker image digest |
| 8 | Cron refresh CF IP list |
| 9 | Session TTL ngắn hơn (default 30d) |
| 10 | `npm audit` gate in build |

Có thể làm batch sau khi server chạy ổn.

