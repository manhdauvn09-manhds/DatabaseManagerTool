# SDD Master Spec — DatabaseManager (v2 Secure Connect)

## Scope
- FE UI + embedded API tối thiểu cho connect.

## Secure Connect Flow
1) FE gọi `GET /api/crypto/public-key` lấy `publicJwk` + `keyId`.
2) FE mã hoá password bằng RSA-OAEP (SHA-256) → `passwordEncrypted`.
3) FE gọi `POST /api/connect` gửi `passwordEncrypted` + `keyId` + host/port/user/dbType.
4) API decrypt, test connection, tạo `connectionId` (TTL in-memory).

## Decisions
- HTTPS bắt buộc khi deploy production.
- Client-side encryption chỉ là defense-in-depth.

## Non-goals
- Không có màn Admin.
- Không connect DB trực tiếp từ browser.
