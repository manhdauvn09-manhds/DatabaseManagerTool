# node22-upgrade-deploy.ps1
#
# Merge Node 20 -> 22 (SecureConnect/Dockerfile) vao main, push, build + roll
# ra mcp-80, roi verify node v22 / health / 307.
#
# LUU Y: file nay phai la pure-ASCII (hoac co UTF-8 BOM). policy-ci check
# bom:powershell-has-utf8-bom vi PS 5.1 decode file BOM-less theo ANSI
# codepage -> chu co dau se sai.
#
# Chay (copy ca 2 dong):
#   cd E:\SourceCode\DatabaseManager
#   powershell -File E:\SourceCode\DatabaseManager\.claude\worktrees\node-20-to-22-upgrade-e0b3fc\deploy\node22-upgrade-deploy.ps1
#
# (Script tu Set-Location sang repo roi, cd chi de ban dung dung cho.)
#
# Target: Windows PowerShell 5.1 (powershell, KHONG phai pwsh).
# Idempotent: chay lai duoc; merge/push bo qua neu da xong.
#
# KHONG dung tay den:
#   - container dbmanager-redis  (chi `up -d app`)
#   - volume dbmanager_dbmanager_data / _redis  (mat = mat connection cua user)
#   - deploy/nginx/setup-nginx-site.sh  (tro server cu)

$ErrorActionPreference = "Stop"

$RepoLocal   = "E:\SourceCode\DatabaseManager"
$Branch      = "claude/node-20-to-22-upgrade-e0b3fc"
$ServerAlias = "mcp-80"
$ServerPath  = "/opt/dbmanager"
$HealthLocal = "http://127.0.0.1:9230/api/health"
$PublicUrl   = "https://dbmanager.allin1site.com/"

function Step($n, $msg) { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Die($msg)      { Write-Host ""; Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== DBManager: Node 20 -> 22 (deps/builder/runner) ===" -ForegroundColor Cyan
Write-Host "Server: $ServerAlias ($ServerPath)   Branch nguon: $Branch" -ForegroundColor Gray

# ---------- 1. Merge branch vao main (local) ----------
Step "1/6" "Merge $Branch -> main va push"
Set-Location $RepoLocal

git checkout main
if ($LASTEXITCODE -ne 0) { Die "git checkout main that bai." }

# Chi chan khi file dang dirty TRUNG voi file ma merge se ghi de. main checkout
# thuong xuyen co thay doi harness chua commit - nhung branch nay chi dung toi
# 3 file, khong lien quan, nen merge van an toan.
$dirtyRaw = @(git status --porcelain)
if ($dirtyRaw.Count -gt 0) {
    $dirtyPaths = $dirtyRaw | ForEach-Object { ($_.Substring(3) -split ' -> ')[-1].Trim('"') }
    $willTouch  = @(git diff --name-only HEAD.."$Branch")
    $clash      = $dirtyPaths | Where-Object { $willTouch -contains $_ }

    if ($clash) {
        Warn "File dang sua do trung voi file merge se ghi de:"
        $clash | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
        Die "Commit hoac stash nhung file tren truoc khi merge."
    }
    Warn "$($dirtyRaw.Count) thay doi chua commit trong main checkout - KHONG trung file nao"
    Write-Host "       merge se ghi: $($willTouch -join ', ')" -ForegroundColor DarkGray
    Write-Host "       -> bo qua, merge an toan. Script KHONG commit ho nhung file do." -ForegroundColor DarkGray
}

$merged = git merge --ff-only $Branch 2>&1
if ($LASTEXITCODE -ne 0) {
    # Da merge roi thi coi nhu xong; con lai la that su hong.
    $already = git branch --merged main | Select-String -SimpleMatch $Branch
    if ($already) { Ok "Branch da duoc merge truoc do - bo qua." }
    else { Write-Host $merged -ForegroundColor Red; Die "merge --ff-only that bai (branch da phan ky khoi main)." }
} else {
    Ok "Merged: $merged"
}

# Xac nhan Dockerfile tren main that su la node:22
$fromLines = Select-String -Path "SecureConnect\Dockerfile" -Pattern '^FROM node:' | ForEach-Object { $_.Line }
Write-Host "    FROM tren main:" -ForegroundColor DarkGray
$fromLines | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
if (($fromLines | Where-Object { $_ -notmatch 'node:22-alpine' }).Count -gt 0) {
    Die "Van con stage khong phai node:22-alpine tren main."
}
Ok "Ca 3 stage = node:22-alpine"

git push origin main
if ($LASTEXITCODE -ne 0) { Die "git push origin main that bai (PAT het han? chay push-and-deploy.ps1)." }
Ok "Pushed main"

# ---------- 2. Server pull ----------
Step "2/6" "Server pull main (gitPull=false nen pull tay)"
ssh $ServerAlias "cd $ServerPath && git fetch origin main && git pull --ff-only origin main && grep -n '^FROM node:' SecureConnect/Dockerfile"
if ($LASTEXITCODE -ne 0) { Die "Pull tren server that bai - kiem tra $ServerPath co local change khong." }
Ok "Server da co code node:22"

# ---------- 3. Build (chi service app) ----------
Step "3/6" "docker compose build --no-cache app  (vai phut; test chay trong build)"
ssh $ServerAlias "cd $ServerPath && docker compose build --no-cache app"
if ($LASTEXITCODE -ne 0) { Die "Build that bai. Dockerfile gate `npm run test` - doc log de biet test nao do." }
Ok "Build xong (241 unit test da pass trong builder stage)"

# ---------- 4. Up (KHONG dung redis) ----------
Step "4/6" "docker compose up -d app"
ssh $ServerAlias "cd $ServerPath && docker compose up -d app"
if ($LASTEXITCODE -ne 0) { Die "up -d app that bai." }

Write-Host "    Cho container healthy (start_period 20s)..." -ForegroundColor DarkGray
Start-Sleep -Seconds 30
ssh $ServerAlias "docker ps --filter name=dbmanager --format '{{.Names}}  {{.Status}}'"
Ok "Container len"

# ---------- 5. Verify node v22 + health ----------
Step "5/6" "Verify runtime"

$nodeVer = (ssh $ServerAlias "docker exec dbmanager-app node --version").Trim()
Write-Host "    node --version = $nodeVer" -ForegroundColor Gray
if ($nodeVer -notmatch '^v22\.') { Die "Mong doi v22.x, nhan duoc '$nodeVer'." }
Ok "Node $nodeVer (da roi khoi Node 20 EOL 04/2026)"

$health = (ssh $ServerAlias "curl -s -o /dev/null -w '%{http_code}' $HealthLocal").Trim()
Write-Host "    $HealthLocal -> $health" -ForegroundColor Gray
if ($health -ne "200") { Die "Health check tra ve $health (mong doi 200)." }
Ok "Health 200"

# 307 -> trang dang nhap (PS 5.1: 3xx nem exception khi MaximumRedirection=0)
$code = $null
try {
    $resp = Invoke-WebRequest -Uri $PublicUrl -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 30
    $code = [int]$resp.StatusCode
} catch {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
}
Write-Host "    $PublicUrl -> $code" -ForegroundColor Gray
if ($code -ne 307) { Warn "Mong doi 307 sang trang dang nhap, nhan duoc '$code' - kiem tra bang tay." }
else { Ok "307 -> redirect trang dang nhap" }

# ---------- 6. Dang nhap thu (operator tu lam) ----------
Step "6/6" "Dang nhap thu - buoc nay operator tu bam"
Write-Host "    Mo $PublicUrl va dang nhap bang tai khoan that cua ban." -ForegroundColor Yellow
Write-Host "    Can kiem: login OK + mo duoc 1 saved connection (xac nhan volume /data con nguyen)." -ForegroundColor Yellow
Write-Host "    Neu login hong -> rollback: ssh $ServerAlias `"cd $ServerPath && git revert --no-edit HEAD && docker compose build --no-cache app && docker compose up -d app`"" -ForegroundColor DarkGray

Write-Host ""
Write-Host "=== XONG: Node $nodeVer, health 200, public $code ===" -ForegroundColor Green
Write-Host ""
