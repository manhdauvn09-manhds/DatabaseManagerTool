# DatabaseManager

Web tool quản lý DB qua UI với Google sign-in bắt buộc và **Secure Connect** (RSA-OAEP client-side encryption + HTTPS).

## Cấu trúc thư mục

```
DatabaseManager/
├── BMAD_SDD_Skills_v2/        # Skill pack + artifacts (vision → quality)
├── SecureConnect/             # Next.js 14 app
│   ├── src/                   # /signin, /app, /api/*, lib/{crypto, connections, schemas}
│   ├── Dockerfile             # Multi-stage build (standalone output)
│   ├── .dockerignore
│   └── .env.example           # Template — copy to .env.production on server
├── docker-compose.yml         # Service "app" (+ optional "caddy" cho HTTPS)
├── Caddyfile                  # Reverse proxy config (optional)
├── deploy.ps1                 # Local → git → SSH server → docker build → verify
├── deploy.config.example.json # Template cho deploy.config.json (gitignored)
├── server-setup.sh            # One-time bootstrap trên server
├── RELEASE_NOTES.md
└── README.md
```

## Deployment flow (local → git → server)

Bạn KHÔNG cần cài Node.js trên máy local. Toàn bộ build chạy trong Docker trên server.

### Lần đầu — chuẩn bị

**Trên máy local:**
```bash
cd E:\SourceCode\DatabaseManager
git init -b main
git remote add origin https://github.com/manhdauvn09-manhds/DatabaseManagerTool.git
# Copy config:
copy deploy.config.example.json deploy.config.json
# Mở deploy.config.json và cập nhật SshKey path (các giá trị khác đã pre-fill).
git add -A && git commit -m "chore: initial commit"
git push -u origin main
```

**Trên server (chạy 1 lần):** xem CLAUDE.md để biết server hiện tại và hướng dẫn deploy (server cũ 62.238.28.106 đã xoá 2026-06-04).

### Deploy lần tiếp theo

Ở máy local, sau khi sửa code:
```powershell
.\deploy.ps1 -Message "fix: signin Suspense"
```
Script tự động:
1. `git add -A && git commit -m "..." && git push origin main`.
2. SSH vào server: `git pull → docker compose up -d --build → docker compose ps`.
3. Health check `HealthUrl` (retry 6 lần × 5s) — verify trả 200 + payload chứa `keyId`/`publicJwk`.

**Các flag hữu ích:** `-SkipCommit`, `-SkipPush`, `-SkipDeploy`, `-SkipVerify`. Xem `Get-Help .\deploy.ps1 -Full` để biết chi tiết.

### ⚠️ Deployment — Cập nhật lên mcp-80 (2026-06-04+)

**Server cũ `62.238.28.106` đã xoá 2026-06-04.** Xem `CLAUDE.md` (ground truth) để biết hướng dẫn deploy hiện tại trên mcp-80 (`65.108.62.80`).

### Deploy lần tiếp theo

Ở máy local, sau khi sửa code, dùng `deploy.ps1` (đã pre-config trong `deploy.config.example.json` — copy thành `deploy.config.json` và điền SSH key path).

```powershell
.\deploy.ps1 -Message "fix: ..."
```

## Local dev (chỉ khi có Node.js)

```bash
cd SecureConnect
cp .env.example .env.local      # điền AUTH_GOOGLE_ID/SECRET, AUTH_SECRET
npm install
npm run dev
```

Mở http://localhost:3000 → redirect `/signin` → Google → `/app`.

## Secure Connect flow (defense-in-depth)

1. FE gọi `GET /api/crypto/public-key` lấy `keyId` + `publicJwk` (RSA-OAEP SHA-256, 2048-bit).
2. FE mã hoá password trong browser bằng WebCrypto → `passwordEncrypted` (base64).
3. FE clear password khỏi React state ngay khi gửi.
4. FE gọi `POST /api/connect` với `{ dbType, host, port, user?, passwordEncrypted, keyId }`.
5. Server decrypt in-memory, test connection (mysql/postgresql/mssql), trả `connectionId` (TTL 30 phút).

**HTTPS vẫn là lớp bảo vệ chính** — client-side encryption chỉ là bổ sung.

## Production notes

- Bắt buộc HTTPS/TLS (reverse proxy hoặc platform).
- Multi-instance: keypair nên quản lý qua KMS/HSM thay vì in-memory ephemeral để tránh `KEY_ROTATED`.
- Không log secret.
- Không persist password (client lẫn server).

## BMAD workflow đã chạy

| Phase | Skill | Output |
|---|---|---|
| Discovery | create_product_brief, create_sdd_master_spec | `0_vision/product_vision.md`, `1_spec/sdd_master_spec.md` |
| Planning | create_prd | `2_planning/PRD.md`, `backlog_epics_stories.md` |
| Solutioning | secure_connection_design, create_api_contract, create_ui_spec | `1_spec/api_contract.md`, `security_privacy_spec.md`, `ui_spec.md`, `2_planning/architecture_frontend.md` |
| Execution | implement_story_fe, frontend_encrypt_password | `SecureConnect/src/**` |
| Quality | security_privacy_review, review_story_fe, release_checklist | xem `RELEASE_NOTES.md` |

## Tài liệu liên quan

- BMAD method overview: [BMAD_SDD_Skills_v2/README.md](BMAD_SDD_Skills_v2/README.md)
- Stories: [BMAD_SDD_Skills_v2/3_execution/stories/](BMAD_SDD_Skills_v2/3_execution/stories/)
- Release notes: [RELEASE_NOTES.md](RELEASE_NOTES.md)
