# auth-diagnose.ps1
#
# Chi DOC, khong sua gi. Thu thap du kien ve loi /api/auth/error sau khi len
# Node 22, de biet loi do Node 22 hay co san tu truoc.
#
# Chay (copy tung dong):
#   cd E:\SourceCode\DatabaseManager
#   powershell -File E:\SourceCode\DatabaseManager\.claude\worktrees\node-20-to-22-upgrade-e0b3fc\deploy\auth-diagnose.ps1
#
# Target: Windows PowerShell 5.1. File pure-ASCII (policy-ci bom check).
# Moi lenh ssh dung chuoi SINGLE-QUOTE de PowerShell khong nuot dau $.

$ErrorActionPreference = "Continue"
$S = "mcp-80"

# Ghi ca man hinh ra file de khong bi cuon mat.
$OutFile = Join-Path $env:TEMP "dbmanager-auth-diagnose.txt"
Start-Transcript -Path $OutFile -Force | Out-Null

function Section($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }

Write-Host ""
Write-Host "### DBManager - chan doan auth (READ-ONLY) ###" -ForegroundColor Cyan

Section "1. Bien auth: CO hay THIEU (khong in gia tri secret)"
$c1 = 'docker exec dbmanager-app printenv'
$envNames = ssh $S $c1 | ForEach-Object { ($_ -split '=')[0] }
foreach ($v in @('AUTH_SECRET','NEXTAUTH_SECRET','AUTH_URL','NEXTAUTH_URL','AUTH_TRUST_HOST','AUTH_GOOGLE_ID','AUTH_GOOGLE_SECRET','ALLOWED_EMAILS','ALLOWED_EMAIL_DOMAINS','AUTH_ALLOW_ANY','REDIS_URL')) {
    if ($envNames -contains $v) { Write-Host "  SET      $v" -ForegroundColor Green }
    else                        { Write-Host "  MISSING  $v" -ForegroundColor Red }
}

Section "2. Gia tri cac bien KHONG phai secret"
$safe = @('AUTH_URL','NEXTAUTH_URL','AUTH_TRUST_HOST','AUTH_ALLOW_ANY','ALLOWED_EMAILS','ALLOWED_EMAIL_DOMAINS','NODE_ENV','REDIS_URL')
ssh $S $c1 | Where-Object { $safe -contains ($_ -split '=')[0] } | ForEach-Object { Write-Host "  $_" }

Section "3. .env.production co mount khong + ten bien ben trong"
ssh $S 'cd /opt/dbmanager && ls -la SecureConnect/.env.production'
ssh $S 'cd /opt/dbmanager && grep -v "^#" SecureConnect/.env.production | grep -v "^$" | cut -d= -f1 | sed "s/^/  /"'

Section "4. Image dbmanager (xem con image cu de rollback nhanh khong)"
ssh $S 'docker images --format "{{.Repository}}:{{.Tag}}  {{.ID}}  {{.CreatedSince}}" | grep -i dbmanager'

Section "5. Node version + container status"
ssh $S 'docker exec dbmanager-app node --version'
ssh $S 'docker ps --filter name=dbmanager --format "{{.Names}}  {{.Status}}"'

Section "6. Redis ping"
ssh $S 'docker exec dbmanager-redis redis-cli ping'

Section "7. Log co chu auth/error 2h qua"
ssh $S 'docker logs --since 2h dbmanager-app 2>&1 | grep -i -E "auth|error|warn" | tail -30'
Write-Host "  (het log)" -ForegroundColor DarkGray

Section "8. Thu goi thang endpoint auth tu tren server"
# Luu y: -w "...%{http_code}" bi vo khi di qua PowerShell -> ssh -> sh.
# Dung -s -S voi head/status rieng cho chac.
ssh $S 'curl -s http://127.0.0.1:9230/api/auth/providers | head -c 400; echo'
ssh $S 'curl -s -D - -o /dev/null http://127.0.0.1:9230/api/auth/csrf | head -1'
ssh $S 'curl -s -D - -o /dev/null http://127.0.0.1:9230/api/auth/signin/google | head -1'

Stop-Transcript | Out-Null
Write-Host ""
Write-Host "### Xong. Output day du da luu o: ###" -ForegroundColor Green
Write-Host "    $OutFile" -ForegroundColor Yellow
Write-Host "Gui file do lai (hoac mo bang: notepad $OutFile)" -ForegroundColor Green
Write-Host ""
