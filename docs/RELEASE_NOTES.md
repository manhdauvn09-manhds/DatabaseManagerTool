# Release Notes — DatabaseManager

## 2026-11-10 — Khôi phục JSON API + sửa các tầng kiểm tra

### Sự cố: toàn bộ JSON API chết 4,5 tháng (2026-06-20 → 2026-11-09)

`next.config.mjs` gắn cứng header `Content-Encoding: gzip` cho mọi route
`/api/*`, trong khi body là JSON thuần. Trình duyệt gunzip thất bại
(`ERR_CONTENT_DECODING_FAILED`) và vứt bỏ response. Đăng nhập Google chết
theo: Auth.js client fetch `/api/auth/providers` thất bại rồi tự chuyển
hướng sang `/api/auth/error`.

Do commit `e6a8a84` (2026-06-20, *"Code quality + Performance improvements
(100x)"*) đưa vào.

**Vì sao không ai phát hiện trong 4,5 tháng**: không một tầng kiểm tra nào
đọc body. `curl`/`wget` bỏ qua `Content-Encoding` trừ khi có `--compressed`,
nên Docker HEALTHCHECK, compose healthcheck và script deploy đều báo 200
xanh suốt thời gian đó.

### Thay đổi

- **Fix**: bỏ header tĩnh; compression thật sự do `compress: true` lo —
  Next tự đặt header khi nó thật sự nén body.
- **Chặn tái phát**: `src/lib/__tests__/nextConfigHeaders.test.ts` cấm mọi
  header transport tĩnh (`content-encoding` / `transfer-encoding` /
  `content-length`). Đã kiểm chứng 2 chiều: FAIL trên config cũ, PASS trên
  config mới.
- **HEALTHCHECK + compose healthcheck**: đọc body, `grep '"ok":true'`.
- **E2E**: thêm test `fetch()` từ trong trang — đường đi thật của người dùng;
  `request.get()` của Playwright là client Node nên đã để lọt bug này. Thêm
  test bấm nút sign-in phải tới Google chứ không rơi vào `/api/auth/error`.
- **`deploy/verify-production.ps1`**: verify mức body dùng lại được, dùng
  `curl --compressed`.
- **CI**: `node-version` 20 → 22 cho khớp production.
- **Ghim Node**: `package.json` `engines` + `.nvmrc` = 22.

### Node 20 → 22 (2026-10-31)

`Dockerfile` dùng `node:22-alpine` ở cả 3 stage. Production: **v22.23.4**
(trước 20.20.2, EOL 04/2026). User `nextjs` (uid 1001) giữ nguyên.
Không liên quan sự cố trên.

### Test

244/244 unit test pass (25 file).

---

## v0.1.0 — bản đầu

## Tổng quan
Phiên bản đầu của DatabaseManager theo BMAD SDD Skills v2 (Secure Connect):
- FE-only UI (Next.js 14) + embedded API tối thiểu cho connect DB.
- Bắt buộc Google sign-in (NextAuth v5 beta) cho `/app/*` và `/api/connect`.
- Defense-in-depth: password mã hoá RSA-OAEP ở browser trước khi gửi.
- Không lưu password ở client; server giữ in-memory với TTL 30 phút.

## Nguồn artifact
- BMAD pack: `BMAD_SDD_Skills_v2/`
- Source code: `SecureConnect/`

## Implementation summary

| Skill | Output |
|---|---|
| `secure_connection_design` | API contract & security spec (đã có sẵn trong `1_spec/`). |
| `frontend_encrypt_password` | `SecureConnect/src/lib/crypto/client.ts`. |
| `implement_story_fe` | `SecureConnect/src/app/**`, `src/lib/**`, `src/middleware.ts`. |
| `security_privacy_review` | Findings ở section "Security review" dưới đây. |
| `release_checklist` | Section "Release checklist" dưới đây. |

## Bug fixes (so với skeleton gốc)
1. **`/api/auth/[...nextauth]/route.ts`** — re-export `handlers.GET/POST` thay vì `GET/POST` (NextAuth v5 beta API).
2. **`/signin/page.tsx`** — bọc `useSearchParams` trong `<Suspense>` để tránh build error trên Next.js 14.
3. Thêm `.gitignore` ở `SecureConnect/`.
4. Thêm `README.md` top-level mô tả cấu trúc + quick start.

## Security review (skill: security_privacy_review)

| Mục | Trạng thái | Ghi chú |
|---|---|---|
| TLS required (production) | ✅ Documented | README + security_privacy_spec nhấn mạnh HTTPS bắt buộc. Deploy ngoài tầm code — qua reverse proxy/platform. |
| Client-side encryption | ✅ Implemented | RSA-OAEP SHA-256, 2048-bit, JWK import qua WebCrypto. |
| Không log secret | ✅ Best-effort | API không gọi `console.log(password)` ở bất kỳ đâu. `password` local var được set `""` sau khi dùng. |
| Không persist secret client | ✅ Implemented | Không dùng `localStorage`/`sessionStorage`; React state `password` được clear sau encrypt. |
| Không persist secret server | ✅ In-memory TTL | `Map`-based store, TTL 30 phút, opportunistic cleanup. **Không scale multi-instance**. |
| Key rotation | ⚠️ Partial | Server trả `409 KEY_ROTATED` khi keyId mismatch. FE hiển thị message nhưng chưa auto-retry. |
| Auth gate | ✅ Implemented | Middleware chặn `/app/*` và `/api/*` (trừ `/api/auth/*`, `/api/crypto/public-key`). |
| Zod validation | ✅ Implemented | `ConnectRequestSchema` validate dbType/host/port/user/passwordEncrypted/keyId. |

### Khuyến nghị tiếp theo
- Auto-retry KEY_ROTATED ở FE để UX mượt hơn.
- Multi-instance production: chuyển keypair sang KMS/HSM (AWS KMS, GCP KMS, Azure Key Vault).
- Audit log (không có secret) cho mỗi lần `/api/connect`.
- Rate-limit `/api/connect` để chống brute force.

## Release checklist (skill: release_checklist)

- [x] Source code skeleton hoàn chỉnh.
- [x] BMAD artifacts đầy đủ (vision → quality).
- [x] Top-level README + RELEASE_NOTES.
- [x] `.env.example` có đủ biến cần thiết.
- [x] `.gitignore` loại trừ `.env`, `node_modules`, `.next`.
- [ ] `npm install` + `npm run build` — **chưa chạy được**: máy hiện không cài Node.js.
- [ ] Smoke test: sign-in Google → connect MySQL local — cần Node.js + Google OAuth client.
- [ ] Deploy HTTPS — out of scope code, phải qua reverse proxy/platform.

## Hướng dẫn verify (sau khi cài Node.js)

```bash
# 1. Cài Node.js 20+ (winget install OpenJS.NodeJS hoặc nodejs.org)
# 2. Vào project
cd SecureConnect

# 3. Cấu hình .env.local
copy .env.example .env.local
# → điền AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET (Google Cloud Console > OAuth 2.0)
# → đảm bảo AUTH_SECRET có random string

# 4. Install + build + dev
npm install
npm run build
npm run dev

# 5. Mở http://localhost:3000 → /signin → Google → /app → test Connect.
```

## Open items / TODO
- Auto-retry KEY_ROTATED ở FE.
- Endpoint `/api/connections/:id` (get/delete) — tận dụng `store.ts` đã có.
- Unit test cho `encryptPasswordRSAOAEP`, `ConnectRequestSchema`, `store.ts` TTL.
- E2E test Playwright cho auth + connect happy path.
