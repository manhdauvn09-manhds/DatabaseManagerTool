# QA Strategy (v2.1)

## Automated tests (vitest)
Gated in Dockerfile `builder` stage — failing test fails the deploy.

| File | Coverage |
|---|---|
| `src/lib/security/__tests__/ssrfGuard.test.ts` | IPv4/IPv6 classification, hostname literal, allowPrivate toggle, AWS metadata always-blocked |
| `src/lib/security/__tests__/rateLimit.test.ts` | Under-limit allow, over-limit block, key isolation, window expiry recovery, getClientIp header precedence |
| `src/lib/security/__tests__/auditLog.test.ts` | JSON format, timestamp, field whitelist drops `password`/`passwordEncrypted`/`keyId`, undefined fields omitted |
| `src/lib/schemas/__tests__/connect.test.ts` | Happy path, port range, host-regex rejects shell metachars, IPv4/IPv6 literals accepted, oversized passwordEncrypted rejected, unknown dbType, optional user, port coercion |

Run locally: `npm run test`. On server: automatic during Docker build.

## Manual smoke tests (post-deploy)

### TC-01 Auth gate
- Truy cập `/app` chưa sign-in → redirect `/signin?next=/app`.
- `POST /api/connect` không session → `401 UNAUTH` JSON (không redirect).
- `GET /api/crypto/public-key` không session → `401 UNAUTH`.
- `GET /api/health` không session → `200 {ok:true}`.

### TC-02 Email allowlist
- Đăng nhập với Google email KHÔNG trong `ALLOWED_EMAILS`/`ALLOWED_EMAIL_DOMAINS` → bị reject (NextAuth error page).
- Đăng nhập với email trong allowlist → vào được `/app`.

### TC-03 Secure connect — happy path
- Sign-in OK → `/app` → nhập DB info → Connect.
- DevTools Network: request `POST /api/connect` body chỉ có `passwordEncrypted` + `keyId`, không có raw password.
- Response: `{ connectionId, dbType }`.
- React state input password = "" sau submit.

### TC-04 SSRF guard
- `host=127.0.0.1` → `403 HOST_BLOCKED` (luôn block dù `ALLOW_PRIVATE_HOSTS=true`).
- `host=169.254.169.254` → `403 HOST_BLOCKED` (luôn block).
- `host=10.0.0.1` với `ALLOW_PRIVATE_HOSTS=false` → `403 HOST_BLOCKED`.
- `host=10.0.0.1` với `ALLOW_PRIVATE_HOSTS=true` → đi tới testConnection (driver sẽ fail nếu không có DB).
- `host=db.example.com` resolve → public IP → đi tới testConnection.

### TC-05 Rate limit
- Gọi `/api/connect` 11 lần liên tiếp trong 1 phút → request thứ 11 trả `429 RATE_LIMIT` + `Retry-After` header.
- Gọi `/api/crypto/public-key` 31 lần / phút từ cùng IP → request thứ 31 trả `429`.

### TC-06 Body size cap
- `POST /api/connect` với body > 4096 bytes → `413 BODY_TOO_LARGE`.

### TC-07 Connect timeout
- `host=10.0.0.1` (unreachable) với `ALLOW_PRIVATE_HOSTS=true` → response trong < 6s với `CONNECT_FAIL` (không hang).

### TC-08 KEY_ROTATED
- Fetch public key → restart container → submit connect → `409 KEY_ROTATED`.

### TC-09 Generic error message
- Sai mật khẩu DB → response message = `"Unable to connect to database"` (KHÔNG chứa driver-specific text như `"ER_ACCESS_DENIED"`).
- `docker compose logs app` → có dòng `[connect] driver error: ...` (server-side log).

### TC-10 Audit log
- `docker compose logs app` → mỗi connect attempt có 1 dòng JSON với `{ts, action:"connect", email, ip, host, port, ok, errCode?, ms?}`.
- Không có field `password`, `passwordEncrypted`, `keyId` trong audit log.

### TC-11 Cloudflare origin protection (nếu enabled)
- `REQUIRE_CLOUDFLARE=true` → curl trực tiếp IP server không qua CF → `403 FORBIDDEN`.
- Qua Cloudflare (CF-Connecting-IP header tự set) → OK.

### TC-12 MSSQL TLS strict
- Connect MSSQL với cert self-signed, `MSSQL_TRUST_SERVER_CERT=false` (mặc định) → `CONNECT_FAIL` (TLS reject).
- Đặt `MSSQL_TRUST_SERVER_CERT=true` → connect OK.

### TC-13 No secret persistence
- Sau khi connect: DevTools → Application tab → localStorage và sessionStorage không có entry chứa password.
- Audit log không log password.

## Tooling
- Manual smoke: DevTools Network + Application + `docker compose logs`.
- Future: Playwright cho auth + form flow; expand vitest cho thêm route handler (mocking next-auth + db drivers).
