# Handoff — DBManager

> Ground truth ha tang: xem `CLAUDE.md`. File nay chi ghi **trang thai thay doi**.

## NOW (2026-10-31)

**Node 20 -> 22 trong `SecureConnect/Dockerfile`: DA LEN PRODUCTION.**

Verify tren mcp-80 (operator chay script, 2026-10-31):
- `docker exec dbmanager-app node --version` = **v22.23.4** (truoc: 20.20.2)
- `http://127.0.0.1:9230/api/health` = **200**
- `https://dbmanager.allin1site.com/` = **307** -> trang dang nhap
- Build trong `builder` stage pass => `npm run test` + `npm run build` deu
  chay duoc tren Node 22 alpine.
**Ticket Ops (nang Node 20 -> 22): DONG.** Muc tieu la roi Node 20 EOL, da
dat va verify tren production.

**Dang nhap KHONG duoc** — nhung nguyen nhan nam o tang proxy (gzip hong),
khong phai do nang Node. Tach thanh bug rieng: **OPEN-5**.

- Commit `0b5a9d9` tren branch `claude/node-20-to-22-upgrade-e0b3fc`, da
  merge ff-only vao `main` va push.
- Diff = **dung 3 dong**: `FROM node:20-alpine` -> `node:22-alpine` o stage
  `deps`, `builder`, `runner`. Khong doi gi khac — user `nextjs` (uid 1001),
  group `nodejs` (gid 1001), entrypoint, HEALTHCHECK, `/data` chown: nguyen ven.
- **Ly do**: Node 20 EOL 04/2026; container dang chay 20.20.2.
- **Test local**: `npm run test` = **241/241 pass, 24 file** (do tai cho,
  2026-10-31 18:47, Node v24.16.0 / npm 11.13.0 tren Windows).
- **`npm run build` local KHONG chay het**: worker chet
  `exit code 3221226505` (0xC0000409, stack buffer overrun cua Windows) o buoc
  "Generating static pages (8/11)". **Day la loi moi truong local, khong phai
  do thay doi nay** — diff chi dung toi Dockerfile, ma `next build` local khong
  doc Dockerfile. Chua doi chieu voi `main` truoc khi sua, nen **chua chung
  minh duoc la pre-existing** -> coi la UNVERIFIED, xem OPEN-1.
- Khong co Docker tren may operator (`docker` not recognized) -> **khong build
  duoc image Node 22 that o local**. Gate that su la `RUN npm run test` +
  `RUN npm run build` ben trong `builder` stage: build server fail thi deploy
  fail to tieng, khong im lang.

## NEXT

1. **Dang nhap thu + mo 1 saved connection** (OPEN-5) — chua xac nhan.
2. Xu ly OPEN-2 (CI con pin Node 20) de CI va production cung phien ban.
3. Main checkout con **~25 file harness chua commit** (`.harness/control/`,
   `CLAUDE.md`, `tools/harness-bundle/`, nhieu file untracked trong
   `.harness/ledger/`). Khong lien quan thay doi nay, script da co tinh bo
   qua. Dang de review + commit rieng.
4. Rollback neu can:
   ```
   ssh mcp-80 "cd /opt/dbmanager && git revert --no-edit HEAD && docker compose build --no-cache app && docker compose up -d app"
   ```

## OPEN

- ~~**OPEN-1 — `npm run build` local crash (0xC0000409).**~~ **DONG
  2026-10-31**: build trong `builder` stage tren mcp-80 pass => crash chi la
  artifact cua moi truong local (Windows + Node v24.16.0), khong phai loi
  code. Lan sau build local hong kieu nay: doi chieu voi `main` truoc khi
  nghi la do minh, hoac bo qua va dua vao build trong Docker.

- **OPEN-5 — KHONG dang nhap duoc: `/api/auth/providers` tra body gzip hong.**
  **Day la bug RIENG, khong thuoc ticket nang Node 22** (xem muc "Quan he voi
  Node 22" ben duoi).

  Chuoi loi (da tai hien duoc 2026-10-31 bang browser, khong can credential):
  1. Bam "Sign in with Google" -> `GET /api/auth/providers`
  2. Response **200** + header `content-encoding: gzip`, nhung body KHONG
     phai gzip hop le -> `net::ERR_CONTENT_DECODING_FAILED`
  3. Auth.js client ném `Failed to fetch` -> `next-auth/react` chuyen huong
     sang `/api/auth/error` (khong co `?error=`, khop URL operator bao)
  Nut bam chua bao gio di toi Google.

  **App KHONG hong**: `curl http://127.0.0.1:9230/api/auth/providers` ngay
  tren server tra JSON dung. Loi phat sinh o tang proxy
  (container -> nginx host -> Cloudflare; header co `server: cloudflare`,
  `cf-ray`). Nghi double-compression: mot tang gzip roi tang sau gzip tiep.

  **Buoc tiep theo** - 2 lenh read-only de biet tang nao:
  ```
  ssh mcp-80 "curl -s -D - -o /tmp/p1.bin -H 'Accept-Encoding: gzip' http://127.0.0.1:9230/api/auth/providers; file /tmp/p1.bin"
  ssh mcp-80 "curl -sk -D - -o /tmp/p2.bin -H 'Accept-Encoding: gzip' -H 'Host: dbmanager.allin1site.com' https://127.0.0.1/api/auth/providers; file /tmp/p2.bin"
  ```
  p1 sach + p2 hong => nginx host. Ca hai sach => Cloudflare. p1 hong =>
  moi phai nghi Next.js/Node.

  **Quan he voi Node 22: CHUA CHUNG MINH DUOC, va co ly do tin la khong.**
  Tang gay loi nam ngoai container. `.env.production` de ngay 19/08 va
  operator chua dang nhap gan day, nen bug co the da ton tai tu lau ma khong
  ai thay: trang HTML tai binh thuong, chi `fetch()` XHR cua Auth.js moi chet
  vi trinh duyet khat khe voi decoding hon. Rollback ve Node 20 **khong**
  duoc coi la cach sua cho den khi p1 chung minh loi nam trong container.
  *until:* chay 2 lenh tren, xac dinh tang, sua tang do, roi login thanh cong
  VA mo duoc 1 saved connection.

- **OPEN-6 — CSP chan Cloudflare beacon.** `script-src 'self' 'unsafe-inline'`
  chan `static.cloudflareinsights.com/beacon.min.js`. Vo hai (chi analytics
  CF khong chay), ghi lai de khoi dieu tra lai.
  *until:* them CF vao CSP, hoac quyet dinh bo analytics.
- **OPEN-2 — CI con pin Node 20.**
  `.github/workflows/ci.yml:26`, `:58` va `.github/workflows/tests.yml:21` van
  `node-version: "20"`. Ngoai scope yeu cau (chi 3 dong Dockerfile), nhung
  de nhu vay thi CI test tren 20 trong khi production chay 22 — drift that.
  *until:* 3 dong do len `22`, hoac co quyet dinh ro la giu 20 co chu dich.
- **OPEN-3 — roll-out/verify phai lam bang tay.**
  Harness guard `deny-by-default` chan `run_command`, `exec_in_container`,
  `deploy` (risk `high`, `unless_in_workflow`) -> assistant khong tu roll ra
  hay doc duoc server. Dung `.ps1` theo C11.
  *until:* chay trong workflow co approval, hoac operator noi khac.

- **OPEN-4 — release gate dang CHAN chinh no (catch-22). C12/C14.**
  `harness-runtime-guard.ps1:280` match `(?i)(deploy|release|...)` tren **ca
  command string**, roi PDP deny vi 3 suite `policy-ci` / `red-team` /
  `golden` stale (>24h). Hau qua: moi lenh shell co chu "deploy" trong
  **duong dan file** cung bi chan — ke ca `harness-release.ps1`, tuc la
  **khong chay duoc chinh cai script sinh ra report de clear gate**.
  Chay tay 3 suite thi pass (red-team 13/13, golden 44/44, policy-ci 49 pass
  / 1 fail) nhung **report van stale** vi chi `harness-release.ps1` moi ghi
  file report.
  - `policy-ci` FAIL duy nhat = `H1:pointer-store: missing
    .harness/context/pipeline-context.yaml` -> **artifact cua worktree**:
    `.harness/context/` bi gitignore (`.gitignore:59`), co trong main
    checkout, khong co trong worktree. Khong phai do thay doi nay.
  *until:* operator chay `harness-release.ps1` tu main checkout (khong bi
  chan o day) de refresh report, hoac sua regex line 280 cho phan biet
  mention vs invocation (comment trong code da biet van de nay).

## AVOID

- Dung chay `deploy/nginx/setup-nginx-site.sh` (tro server cu da xoa).
- Dung `docker compose up -d` tran — chi `up -d app`, khong dung
  `dbmanager-redis`.
- Dung recreate 2 volume `dbmanager_dbmanager_data` / `dbmanager_dbmanager_redis`.
- Dung tin `deploy.config.example.json` (IP `62.238.28.106` = server cu).
