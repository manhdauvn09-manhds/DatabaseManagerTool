# Product Vision — DatabaseManager

## Goal
Web tool để member sign-in Google và quản lý DB qua UI.

## Scope note
- FE UI là chính.
- API layer tối thiểu (embedded) chỉ để connect DB an toàn.

## Security
- Bắt buộc sign-in
- Không lưu DB password
- Defense-in-depth: passwordEncrypted + HTTPS
