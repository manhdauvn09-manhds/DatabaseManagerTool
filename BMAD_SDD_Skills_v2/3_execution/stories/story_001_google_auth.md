# Story 001 — Google Sign-in Gate

## AC
- /app và /api/* yêu cầu sign-in.

## Implementation
- `SecureConnect/src/auth.ts` — NextAuth v5 cấu hình Google provider, JWT session.
- `SecureConnect/src/app/api/auth/[...nextauth]/route.ts` — re-export `handlers.GET/POST`.
- `SecureConnect/src/middleware.ts` — chặn `/app/*` và `/api/*` (trừ `/api/auth/*` và `/api/crypto/public-key`), redirect về `/signin?next=<path>`.
- `SecureConnect/src/app/signin/page.tsx` — Google sign-in button, bọc `useSearchParams` trong `<Suspense>`.

## Done checklist
- [x] Middleware redirect khi không có session.
- [x] `/api/connect` trả `401 UNAUTH` khi không có session.
- [x] Trang `/signin` dùng `signIn("google")`.
- [x] `.env.example` liệt kê `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET`.

## Notes
- Khi deploy qua reverse proxy / non-localhost: set `AUTH_TRUST_HOST=true`.
- `/api/crypto/public-key` để mở (public) — chỉ trả public JWK, không nhạy cảm.
