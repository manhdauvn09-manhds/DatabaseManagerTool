# Handoff — DBManager

> Ground truth ha tang: xem `CLAUDE.md`. File nay ghi **trang thai thay doi**.
> Cap nhat lan cuoi: **2026-11-10**.

## NOW

### 1. JSON API da song lai — DA DEPLOY, DA XAC NHAN

Fix `d738f5c` len production **2026-11-10**. Su co keo dai tu 2026-06-20,
tong cong khoang **4,5 thang** khong ai dang nhap duoc.

**Bang chung (do bang trinh duyet that, khong phai bang curl):**

| Kiem | Ket qua |
|---|---|
| `/api/health` | 200, `{"ok":true,...}`, 43 bytes, doc duoc |
| `/api/auth/csrf` | 200, JSON hop le, 80 bytes |
| `/api/auth/providers` | 200, JSON hop le, 200 bytes |
| `/api/auth/session` | 200, `null`, 4 bytes |
| Content-Encoding | `zstd` — Cloudflare tu nen dung, app thoi noi doi |
| Bam nut Sign in | toi **accounts.google.com** that, trang nhap email |
| `redirect_uri` Google nhan | `https://dbmanager.allin1site.com/api/auth/callback/google` |
| PKCE | `code_challenge_method=S256`, scope `openid profile email` |
| Node | v22.23.4 |
| Redis | PONG |
| Log 1h | sach, khong co `[auth][error]` |

Google **chap nhan** redirect_uri -> nghi van cu ve `redirect_uri_mismatch`
va ve allowlist email deu bi loai bo.

**Con lai duy nhat**: dang nhap bang tai khoan that + mo 1 saved connection.
Assistant khong duoc nhap credential vao production nen khong tu kiem duoc
(OPEN-5).

**Nguyen nhan goc da sua:**

**Nguyen nhan** — `SecureConnect/next.config.mjs` gan cung header
`Content-Encoding: gzip` cho moi route `/api/*`:

```js
{ source: "/api/:path*", headers: [...API_CACHE_HEADERS,
  { key: "Content-Encoding", value: "gzip" } ]}   // <- body la JSON thuan
```

Header noi body da gzip, nhung body la JSON thuan. Trinh duyet gunzip that
bai -> `ERR_CONTENT_DECODING_FAILED` -> mat trang response. Dang nhap chet
vi Auth.js client fetch `/api/auth/providers` that bai roi tu chuyen huong
sang `/api/auth/error` (khong kem `?error=`, dung nhu trieu chung thay tren
production).

Do commit `e6a8a84` (2026-06-20) dua vao — tieu de commit:
*"Code quality + Performance improvements (100x)"*.

**Vi sao song duoc 4,5 thang**: khong mot tang kiem tra nao doc body.
`curl` va `wget` bo qua `Content-Encoding` tru khi co `--compressed`, nen
Docker HEALTHCHECK (`-O /dev/null`), compose healthcheck va script roll-out
(`curl -o /dev/null -w %{http_code}`) deu bao **200 xanh** trong suot thoi
gian API chet. Chi trinh duyet that moi giai nen.

Deploy xong 2026-11-10. Verify muc body: xem muc 3.

### 2. Node 20 -> 22: XONG

Production chay **Node v22.23.4** (truoc: 20.20.2, EOL 04/2026). Deploy
2026-10-31, verify: health 200, public 307. `SecureConnect/Dockerfile` dung
`node:22-alpine` o ca 3 stage (`deps`/`builder`/`runner`), user `nextjs`
(uid 1001) giu nguyen.

Node 22 **khong** lien quan gi den bug o muc 1 — bug co truoc do 4 thang.

### 3. Cac tang kiem tra gio nhin vao BODY (`1606155`)

| Thay doi | File |
|---|---|
| HEALTHCHECK doc body, `grep '"ok":true'` | `SecureConnect/Dockerfile` |
| compose healthcheck tuong tu (CMD-SHELL de co pipe) | `docker-compose.yml` |
| e2e: `fetch()` **tu trong trang** + test bam nut sign-in | `SecureConnect/e2e/smoke.spec.ts` |
| Verify production dung lai duoc, co `curl --compressed` | `deploy/verify-production.ps1` |
| CI `node-version` 20 -> 22 | `.github/workflows/{ci,tests}.yml` |
| Ghim Node 22 cho may dev | `SecureConnect/package.json` (`engines`), `.nvmrc` |
| Test chan tai phat header transport | `src/lib/__tests__/nextConfigHeaders.test.ts` |

`nextConfigHeaders.test.ts` **da duoc kiem chung 2 chieu**: FAIL tren config
cu (bao dung `"/api/:path* -> Content-Encoding: gzip"`), PASS tren config moi.

Unit test: **244/244 pass, 25 file**.

Chay verify bat cu luc nao:
```
cd E:\SourceCode\DatabaseManager
powershell -File E:\SourceCode\DatabaseManager\deploy\verify-production.ps1
```

## NEXT

1. **Dang nhap thu + mo 1 saved connection** (OPEN-5) — viec duy nhat con
   lai de dong hoan toan su co.
2. Doi Node tren may dev ve 22 (OPEN-1) de lay lai kha nang verify o local.
3. Commit 24 file harness 1.8.20 dang treo trong main checkout. **Xem ky
   truoc khi `git add -A`**: `.harness/portal-sync.json` tung bi policy-ci
   canh bao chua `member_email`, va `.harness/ledger/*` la state may-local
   ma commit `d55c646` da chu dong ngung track.
4. Xac nhan job `e2e` chay xanh tren CI (OPEN-2).

## OPEN

- **OPEN-1 — may dev khong chay noi Next.js.**
  Ca `next build` lan `next dev` deu crash `3221226505` (0xC0000409, stack
  buffer overrun) tren **Node v24.16.0 / Windows 11**. Next.js 14.2.35 ra
  truoc Node 24; production chay Node 22 va build trong Docker thi binh
  thuong, nen gan nhu chac la do lech phien ban Node.
  **Day khong phai phien toai vat — day la nguyen nhan cau truc cua 4,5
  thang mu.** Khong chay duoc app o local thi moi kiem tra bi day sang
  `curl` ban vao production, ma `curl` mu dung loai bug nay.
  Da them `engines` + `.nvmrc` ghim Node 22 de khoi lech tiep.
  *until:* cai Node 22 o local (nvm-windows: `nvm install 22 && nvm use 22`),
  chay duoc `npm run build` va `npm run e2e`.

- **OPEN-2 — 2 test e2e moi chua chay lan nao.**
  Chung dung logic da duoc chung minh bang tay (fetch trong trinh duyet that
  that bai tren production dang hong, trong khi HTML van OK), nhung **ban
  than file Playwright chua chay xanh o dau ca** vi may dev khong build duoc
  (OPEN-1). C12: chua chay thi chua phai gate.
  *until:* CI chay job `e2e` xanh tren PR nay, hoac chay duoc o local sau
  khi xu ly OPEN-1.

- **OPEN-3 — eval gate tu chan chinh no (catch-22).**
  `harness-runtime-guard.ps1:280` match `(?i)(deploy|release|...)` tren **ca
  command string**, roi PDP deny vi 3 suite `policy-ci`/`red-team`/`golden`
  stale (>24h). Hau qua: moi lenh shell co chu "deploy" trong **duong dan
  file** cung bi chan — ke ca `harness-release.ps1`, tuc la khong chay duoc
  chinh script sinh ra report de clear gate. Chay tay 3 suite thi pass
  (red-team 13/13, golden 44/44, policy-ci 49 pass / 1 fail) nhung report
  van stale vi chi `harness-release.ps1` moi ghi file report.
  FAIL duy nhat cua policy-ci la `H1:pointer-store: missing
  .harness/context/pipeline-context.yaml` — artifact cua worktree
  (`.harness/context/` bi gitignore o `.gitignore:59`, co trong main
  checkout, khong co trong worktree).
  *until:* chay `harness-release.ps1` tu main checkout, hoac sua regex dong
  280 cho phan biet mention vs invocation.

- **OPEN-5 — chua dang nhap that bang tai khoan thuc.**
  Toan bo luong da duoc xac nhan toi tan trang dang nhap Google (xem bang o
  muc 1), nhung buoc nhap credential + mo 1 saved connection thi assistant
  khong duoc lam tren production. Day la buoc duy nhat chung minh phan sau
  callback (tao session, giai ma AES saved-connections) con chay.
  *until:* operator login thanh cong VA mo duoc 1 saved connection.

- **OPEN-4 — CSP chan Cloudflare beacon.**
  `script-src 'self' 'unsafe-inline'` chan
  `static.cloudflareinsights.com/beacon.min.js`. Vo hai (chi analytics CF
  khong chay), ghi lai de khoi dieu tra lai.
  *until:* them CF vao CSP, hoac quyet dinh bo analytics.

## AVOID

- **Dung bao gio dat `Content-Encoding` lam header tinh** trong
  `next.config.mjs` hay nginx. Day la chuyen cua tang nen byte: ai nen thi
  nguoi do dat. Mot gia tri tinh khong the biet body that su la gi.
  `nextConfigHeaders.test.ts` chan viec nay.
- **Dung ket luan "API on" tu status code.** `curl`/`wget` khong `--compressed`
  bo qua Content-Encoding. Kiem bang `curl --compressed` hoac trinh duyet that.
- Dung chay `deploy/nginx/setup-nginx-site.sh` (tro server cu da xoa).
- Dung `docker compose up -d` tran — chi `up -d app`, khong dung
  `dbmanager-redis`.
- Dung recreate 2 volume `dbmanager_dbmanager_data` / `dbmanager_dbmanager_redis`.

## Lich su gan day

| Ngay | Viec |
|---|---|
| 2026-06-20 | `e6a8a84` dua vao header `Content-Encoding` gia — API chet tu day |
| 2026-10-31 | Node 20 -> 22, deploy + verify (v22.23.4) |
| 2026-11-09 | Tim ra bug Content-Encoding, fix + test chan tai phat |
| 2026-11-10 | Sua cac tang kiem tra de nhin vao body; cap nhat tai lieu |
| 2026-11-10 | **Deploy fix. API song lai, xac nhan bang trinh duyet that** |
