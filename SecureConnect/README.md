# DatabaseManager — Secure Connect (FE + Embedded API)

Mục tiêu: gen skeleton code cho **Secure Connect** theo yêu cầu:
- Bắt buộc Google sign-in mới dùng được
- Form connect DB (host/port/user/password/dbType)
- Password được mã hoá ở browser (RSA-OAEP) trước khi gửi (defense-in-depth)
- Backend (API route) giải mã và test connection, trả `connectionId`
- Không lưu password ở client; backend chỉ giữ in-memory theo TTL

## Vì sao vẫn cần HTTPS?
Client-side encryption chỉ là lớp bổ sung. **HTTPS (TLS) mới là lớp bảo vệ chính** cho toàn bộ traffic.

## Setup
1) Cài deps
```bash
npm i
```

2) Tạo `.env.local` từ `.env.example`
- AUTH_GOOGLE_ID
- AUTH_GOOGLE_SECRET
- AUTH_SECRET

3) Chạy dev
```bash
npm run dev
```

## Endpoints
- `GET /api/crypto/public-key` → trả public key + keyId
- `POST /api/connect` → yêu cầu session, decrypt password, test connection, trả connectionId

## Lưu ý production
- Deploy bằng HTTPS (reverse proxy / platform)
- Multi-instance: keypair nên lấy từ KMS/HSM, tránh lỗi KEY_ROTATED khi instance restart.
