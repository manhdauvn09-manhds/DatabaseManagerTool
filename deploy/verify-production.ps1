# verify-production.ps1
#
# Kiem tra production DBManager o muc BODY, khong chi status code.
# Chay sau moi lan roll-out, va bat cu khi nao nghi ngo.
#
# Chay (copy tung dong):
#   cd E:\SourceCode\DatabaseManager
#   powershell -File E:\SourceCode\DatabaseManager\deploy\verify-production.ps1
#
# Target: Windows PowerShell 5.1 (powershell, KHONG phai pwsh). Pure-ASCII.
# Chi DOC, khong sua gi tren server.
#
# VI SAO CO FILE NAY
# Tu 2026-06-20 den 2026-11-09, toan bo JSON API chet trong trinh duyet
# (Content-Encoding: gzip gia tren body JSON thuan) nhung MOI phep kiem deu
# bao xanh: `curl -o /dev/null -w %{http_code}`, `wget -O /dev/null`, Docker
# HEALTHCHECK. Ly do: khong cai nao giai nen body.
# `curl --compressed` CO giai nen, nen no bat duoc dung lop loi do.

$ErrorActionPreference = "Continue"
$S          = "mcp-80"
$Origin     = "http://127.0.0.1:9230"
$PublicUrl  = "https://dbmanager.allin1site.com/"
$JsonPaths  = @("/api/health", "/api/auth/providers", "/api/auth/csrf", "/api/auth/session")

$script:Fail = 0
function Ok($m)   { Write-Host "  PASS  $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  FAIL  $m" -ForegroundColor Red; $script:Fail++ }
function Warn($m) { Write-Host "  WARN  $m" -ForegroundColor Yellow }
function Section($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }

Write-Host ""
Write-Host "### DBManager - verify production (body-level) ###" -ForegroundColor Cyan

Section "1. Container + Node version"
$node = (ssh $S 'docker exec dbmanager-app node --version') 2>$null
if ($node -match '^v(\d+)\.') {
    $major = [int]$Matches[1]
    if ($major -ge 22) { Ok "Node $node" } else { Bad "Node $node - production phai >= v22 (20 da EOL 04/2026)" }
} else { Bad "Khong doc duoc node version" }

$ps = (ssh $S 'docker ps --filter name=dbmanager --format "{{.Names}} {{.Status}}"') 2>$null
$ps | ForEach-Object {
    if ($_ -match 'unhealthy') { Bad $_ } elseif ($_) { Ok $_ }
}

Section "2. JSON API giai nen duoc (curl --compressed)"
# Day la phep kiem quan trong nhat. --compressed yeu cau gzip VA giai nen that;
# header noi doi se lam curl bao loi thay vi im lang tra ve byte rac.
foreach ($p in $JsonPaths) {
    $body = (ssh $S "curl -s --compressed --max-time 10 $Origin$p") 2>$null
    $rc   = $LASTEXITCODE
    if ($rc -ne 0) {
        Bad "$p - curl --compressed loi (exit $rc). Nghi header Content-Encoding sai."
        continue
    }
    if (-not $body) { Bad "$p - body rong"; continue }
    try {
        $null = $body | ConvertFrom-Json
        Ok "$p - JSON hop le ($($body.Length) bytes)"
    } catch {
        Bad "$p - body khong phai JSON: $($body.Substring(0, [Math]::Min(60, $body.Length)))"
    }
}

Section "3. /api/health dung noi dung"
$h = (ssh $S "curl -s --compressed --max-time 10 $Origin/api/health") 2>$null
if ($h -match '"ok"\s*:\s*true') { Ok "health tra ok:true" } else { Bad "health khong co ok:true: $h" }

Section "4. Duong cong khai (qua nginx + Cloudflare)"
$code = $null
try {
    $r = Invoke-WebRequest -Uri $PublicUrl -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 30
    $code = [int]$r.StatusCode
} catch {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
}
if ($code -eq 307) { Ok "$PublicUrl -> 307 (trang dang nhap)" } else { Bad "$PublicUrl -> $code, mong doi 307" }

# Qua duong cong khai, kiem lai bang curl --compressed de bat double-compression
# do nginx/Cloudflare them vao (khac han loi o tang app).
$pub = (ssh $S "curl -s --compressed --max-time 15 -H 'Host: dbmanager.allin1site.com' -k https://127.0.0.1/api/health") 2>$null
if ($LASTEXITCODE -ne 0) {
    Bad "Qua nginx host: curl --compressed loi (exit $LASTEXITCODE) - nghi nginx gzip chong"
} elseif ($pub -match '"ok"\s*:\s*true') {
    Ok "Qua nginx host: JSON giai nen duoc"
} else {
    Warn "Qua nginx host: khong doc duoc ok:true (co the vhost khong nghe tren 127.0.0.1)"
}

Section "5. Redis"
$ping = (ssh $S 'docker exec dbmanager-redis redis-cli ping') 2>$null
if ($ping -match 'PONG') { Ok "redis PONG" } else { Bad "redis khong tra PONG: $ping" }

Section "6. Log loi 1h qua"
# `grep -c` in ra "0" nhung THOAT voi exit 1 khi khong khop gi, nen PowerShell
# nhan chuoi rong va script cu bao dong gia moi lan log sach. Dung `| wc -l`:
# luon in mot so va luon exit 0. (C14: canh bao sai lam mat uy tin kenh canh bao.)
$errRaw = (ssh $S 'docker logs --since 1h dbmanager-app 2>&1 | grep -i -E "\[auth\]\[error\]|FATAL|unhandled" | wc -l') 2>$null
$errCount = ($errRaw | Out-String).Trim()
if ($errCount -match '^\d+$') {
    if ([int]$errCount -eq 0) { Ok "khong co loi nghiem trong" }
    else { Warn "$errCount dong log dang nghi - xem: ssh $S 'docker logs --since 1h dbmanager-app'" }
} else {
    Warn "khong doc duoc log (ssh loi?) - chua ket luan duoc, KHONG coi la pass"
}

Write-Host ""
if ($script:Fail -eq 0) {
    Write-Host "### TAT CA PASS ###" -ForegroundColor Green
    Write-Host "Luu y: dang nhap Google that van phai thu bang tay - script khong the thay the." -ForegroundColor DarkGray
    exit 0
} else {
    Write-Host "### $($script:Fail) MUC FAIL - production CHUA on ###" -ForegroundColor Red
    exit 1
}
