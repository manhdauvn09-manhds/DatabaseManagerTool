# Handoff — DBManager

> Ground truth ha tang: xem `CLAUDE.md`. File nay chi ghi **trang thai thay doi**.

## NOW (2026-10-31)

**Node 20 -> 22 trong `SecureConnect/Dockerfile`: code xong, CHUA deploy.**

- Commit `0b5a9d9` tren branch `claude/node-20-to-22-upgrade-e0b3fc`
  (worktree `.claude/worktrees/node-20-to-22-upgrade-e0b3fc`).
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

1. Operator chay:
   ```
   powershell -File E:\SourceCode\DatabaseManager\deploy\node22-upgrade-deploy.ps1
   ```
   Script tu: merge branch -> `main`, push, `git pull --ff-only` tren mcp-80,
   `docker compose build --no-cache app`, `up -d app` (**khong dung redis**),
   roi verify `node --version` = v22.x, health 200, public 307.
2. Buoc cuoi (**dang nhap thu**) operator tu bam — assistant khong duoc nhap
   credential that vao site production.
3. Xac nhan mo duoc 1 saved connection sau khi login => volume
   `dbmanager_dbmanager_data` con nguyen.

## OPEN

- **OPEN-1 — `npm run build` local crash (0xC0000409).**
  Chua biet la pre-existing hay khong. Khong chan deploy (build trong Docker
  dung Node 22 alpine, moi truong khac hoan toan).
  *until:* build trong `builder` stage tren mcp-80 pass => dong, va ghi lai day
  la artifact cua Windows/Node 24 local.
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
