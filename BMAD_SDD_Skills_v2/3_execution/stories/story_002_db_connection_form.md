# Story 002 — Secure Connect Form

## Context
User nhập host/port/user/password/dbType.

## Secure steps
1) GET /api/crypto/public-key
2) Encrypt password (RSA-OAEP) → passwordEncrypted
3) Clear password from FE state
4) POST /api/connect with passwordEncrypted + keyId

## AC
- Không gửi raw password qua network.
- API trả connectionId.
- KEY_ROTATED được handle (refetch public key và retry).

## Implementation
- FE form: `SecureConnect/src/app/app/page.tsx` — fields dbType/host/port/user/password, button Connect.
- WebCrypto encrypt: `SecureConnect/src/lib/crypto/client.ts` — `encryptPasswordRSAOAEP(password, publicJwk)` import JWK với `RSA-OAEP SHA-256`, encrypt, base64 encode.
- Server key store: `SecureConnect/src/lib/crypto/serverKeyStore.ts` — ephemeral 2048-bit RSA keypair in-memory, sinh `keyId` random UUID.
- API route `/api/crypto/public-key`: `SecureConnect/src/app/api/crypto/public-key/route.ts` — trả `{ keyId, publicJwk }`.
- API route `/api/connect`: `SecureConnect/src/app/api/connect/route.ts` — kiểm tra session → validate Zod → so sánh `keyId` (mismatch → 409 KEY_ROTATED) → decrypt → test connection (mysql/pg/mssql) → tạo record TTL 30 phút → trả `{ connectionId, dbType }`.
- TTL store: `SecureConnect/src/lib/connections/store.ts` — `Map`-based in-memory, opportunistic cleanup.
- DB test: `SecureConnect/src/lib/connections/testConnection.ts` — auto-guess theo port nếu `dbType=auto`.

## Done checklist
- [x] Password được mã hoá ở browser; payload mạng không chứa raw password.
- [x] FE clear `password` state ngay sau khi gọi encrypt.
- [x] Server không log password (best-effort), local var `password` được set `""` sau khi lưu vào record.
- [x] `keyId` mismatch → response `409 { code: "KEY_ROTATED" }`. (FE có thể bắt và retry — TODO: thêm auto-retry nếu cần.)
- [x] Zod schema validate payload (`ConnectRequestSchema`).
- [x] TTL store 30 phút, không persist.

## Open items
- Auto-retry KEY_ROTATED ở FE: hiện FE mới hiển thị message; nếu cần seamless retry, thêm flow re-fetch public key + re-encrypt + resend.
- Multi-instance production: chuyển keypair sang KMS/HSM thay vì in-memory ephemeral.
