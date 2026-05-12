# DatabaseManager — BMAD Skill Pack (v2: Secure Connect)

Bộ skill này là phiên bản **đã sửa theo yêu cầu mới**:
- **FE-only UI** (không có màn Admin riêng)
- Có **API layer tối thiểu (BFF embedded)** để thực hiện connect DB một cách an toàn
- **Bắt buộc Google sign-in** mới được dùng (cả UI và API)
- **Defense-in-depth**: password DB được **mã hoá ở browser** trước khi gửi lên API (RSA-OAEP) + vẫn bắt buộc HTTPS khi deploy
- **Không lưu password** ở client (localStorage/sessionStorage) và backend chỉ giữ in-memory theo TTL

> Ghi chú: HTTPS/TLS vẫn là lớp bảo vệ chính. Client-side encryption là lớp bổ sung theo yêu cầu “security tối đa”.

## Cấu trúc
- `bmad/agents/*` : persona theo vai trò
- `bmad/workflows/*` : workflow end-to-end
- `bmad/skills/*` : skill tạo artifacts + implement + review + security gates
- `0_vision/`, `1_spec/`, `2_planning/`, `3_execution/`, `4_quality/` : artifacts (đã prefill)

## Điểm thay đổi chính so với v1
1) Update `1_spec/api_contract.md`:
   - `GET /api/crypto/public-key` (publicJwk + keyId)
   - `POST /api/connect` nhận `passwordEncrypted` + `keyId`
2) Update security spec:
   - Không lưu secret
   - Key rotation handling
   - HTTPS required
3) Add skills:
   - `secure_connection_design`
   - `frontend_encrypt_password`
4) Update story 002 để phản ánh flow mã hoá password.

## Run BMAD (gợi ý)
1) Discovery: `bmad/skills/create_product_brief.md` + `create_sdd_master_spec.md`
2) Planning: `bmad/skills/create_prd.md`
3) Solutioning: `bmad/skills/secure_connection_design.md` + `create_api_contract.md` + `create_ui_spec.md`
4) Execution: `bmad/skills/implement_story_fe.md` theo `3_execution/stories/*`
5) Quality: `bmad/skills/security_privacy_review.md` + `create_test_plan.md` + `release_checklist.md`
