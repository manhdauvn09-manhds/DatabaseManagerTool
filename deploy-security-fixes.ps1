#Requires -Version 5.1
# deploy-security-fixes.ps1
# Commit + push cac fix bao mat V-01..V-06, roi build & deploy len mcp-80.
#
# Chay:  powershell -File E:\SourceCode\DatabaseManager\deploy-security-fixes.ps1
#
# Idempotent: chay lai khi working tree sach thi bo qua commit, chi push + deploy.
# KHONG dung toi 2 volume du lieu (dbmanager_data / dbmanager_redis).

$ErrorActionPreference = 'Stop'
$repo = 'E:\SourceCode\DatabaseManager'

Write-Host "==> cd $repo"
Set-Location $repo

Write-Host "==> Nhanh:"
git rev-parse --abbrev-ref HEAD

# ---------------------------------------------------------------- 1. Gate
Write-Host ""
Write-Host "==> Chay lai toan bo suite truoc khi commit (khong pass thi dung)"
powershell -NoProfile -File "$repo\.harness\scripts\powershell\harness-eval.ps1"
if (-not $?) { throw "harness-eval that bai - KHONG commit" }

# ---------------------------------------------------------------- 2. Commit
Write-Host ""
$changes = git status --porcelain
if (-not $changes) {
    Write-Host "    working tree sach - bo qua commit"
} else {
    Write-Host "==> So file thay doi:"
    ($changes | Measure-Object -Line).Lines

    git add -A
    if (-not $?) { throw "git add that bai" }

    # Message qua FILE, khong qua -m: PowerShell 5.1 tach lai argument theo dau "
    # nam trong here-string khi truyen cho native exe, lam vo message thanh pathspec.
    $msgLines = @(
        'fix(security): dong duong share->write, bat TLS cho PG, sua gate CRLF',
        '',
        'Ra soat toan bo source (docs/SECURITY_AUDIT_2026-08-18.html) tim ra 11 van de.',
        'Commit nay xu ly 5 cai sua duoc bang code:',
        '',
        'V-01 Critical - share link chi-doc ghi duoc vao DB cua chu so huu.',
        '  /api/db/[id]/query dat allowShare:true trong khi no chay SQL tu do, va',
        '  validateSql() chi la regex denylist. Tren PG (simple query protocol) va',
        '  MSSQL (batch), chuoi bat dau bang SELECT van mang theo statement khac sau',
        '  dau ; - vd COPY ... TO PROGRAM = chay lenh OS. Da go allowShare khoi',
        '  query + ai-sql, va an tab SQL o FE cho share user (khong an thi ho van',
        '  bam vao roi nhan 403 kho hieu).',
        '',
        'V-02 Critical - ket noi PostgreSQL chay PLAINTEXT theo mac dinh.',
        '  node-postgres hieu ssl:undefined la KHONG TLS, khong phai TLS long. Vi',
        '  DB_SSL_STRICT mac dinh false, mat khau DB va toan bo du lieu di cleartext.',
        '  Da cho PG dung dung mo hinh cua MySQL: TLS luon bat, strict la tuy chon.',
        '',
        'V-03 High - chan multi-statement o tang driver thay vi tang regex.',
        '  Luon truyen mang values cho pg (ke ca rong) de dung EXTENDED protocol,',
        '  noi mot request = mot statement, do driver bao dam chu khong phai do',
        '  doan dung tu khoa.',
        '',
        'V-04 High - ctx.readonly duoc tinh nhung khong noi nao doc.',
        '  authorize() nhan mutation:true; khai bao ca allowShare lan mutation bi',
        '  tu choi nhu loi cau hinh. Share token gui toi route ghi gio tra 403 kem',
        '  ma rieng SHARE_READONLY thay vi im lang roi rot xuong 404 - "co nguoi thu',
        '  ghi qua share link" la su kien can nhin thay ve sau (C14). +5 test.',
        '',
        'V-06 Medium - route query tra nguyen van loi driver, ro ten bang/cot/duong',
        '  dan. Da che giong moi route khac.',
        '',
        'Ngoai ra, hai gate cua chinh harness:',
        '',
        '- .gitattributes thieu rule *.py. core.autocrlf tren Windows doi script',
        '  Python cua harness thanh CRLF luc checkout, doi hash, nen harness doctor',
        '  bao "31 of 98 bundled scripts no longer match receipt" tren MOI clone moi',
        '  ke ca CI - trong khi working tree cua dev nhin van sach. Script chua bao',
        '  gio bi sua, chi co line ending bi doi.',
        '',
        '- harness-gate: bo --strict o job doctor. doctor kiem tra BANG CHUNG runtime',
        '  (ledger, telemetry) ma nhung file do co chu y gitignore, nen CI checkout',
        '  khong bao gio co - gate do 100% va khong the xanh. Mot gate luon do day',
        '  nguoi ta den cho quen di mau do (C14). Cac job con lai van chan build.',
        '',
        'Con mo: V-05 (MySQL TLS khong kiem cert), V-07..V-10, va V-11 (firewall) -',
        'V-11 can thao tac phia server, khong thuoc commit nay.',
        '',
        'Suite: 241/241 pass, tsc --noEmit sach, policy-ci/red-team/golden xanh.',
        '',
        'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
    )
    $msgFile = Join-Path $env:TEMP 'dbm-secfix-msg.txt'
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($msgFile, ($msgLines -join "`n"), $utf8NoBom)

    Write-Host "==> git commit"
    git commit -F $msgFile
    if (-not $?) { throw "git commit that bai" }
    Remove-Item $msgFile -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 3. Push
Write-Host ""
Write-Host "==> git push origin main"
git push origin main
if (-not $?) { throw "git push that bai - kiem tra PAT GitHub" }

git fetch origin main --quiet
Write-Host "==> local vs remote (mong doi: 0  0)"
git rev-list --left-right --count origin/main...main

# ---------------------------------------------------------------- 4. Deploy
Write-Host ""
Write-Host "============================================================"
Write-Host " DA PUSH XONG. Buoc deploy chua chay tu dong."
Write-Host "============================================================"
Write-Host ""
Write-Host " Deploy bang MCP tool trong phien Claude:"
Write-Host '   deploy { server_id: "mcp-80", app_id: "dbmanager" }'
Write-Host ""
Write-Host " Sau deploy, kiem tra:"
Write-Host "   https://DBManager.allin1site.com/api/health  -> 200"
Write-Host ""
Write-Host " VA kiem tra tren Actions tab (C12 - gate phai chung minh da chay):"
Write-Host "   https://github.com/manhdauvn09-manhds/DatabaseManagerTool/actions"
Write-Host "   harness-gate va tests phai co run XANH cho commit nay."
Write-Host "   Lan truoc harness-gate do vi doctor --strict; commit nay sua cai do."
Write-Host ""
Write-Host " LUU Y ve V-02: fix nay lam PG bat dau dung TLS. Neu co user dang ket"
Write-Host " noi toi PG server KHONG ho tro TLS, ho se mat ket noi va can dat"
Write-Host " DB_SSL_DISABLED=true. Doi lai, mat khau ho khong con di cleartext."
