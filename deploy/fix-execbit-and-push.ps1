#Requires -Version 5.1
# fix-execbit-and-push.ps1
# Go tac deploy: dua exec bit vao git, push, roi don working tree tren server.
#
# Chay:  powershell -File E:\SourceCode\DatabaseManager\fix-execbit-and-push.ps1
#
# VI SAO CAN CAI NAY
#   Tren /opt/dbmanager, deploy/backup-data.sh dang la 100755 (co nguoi chmod +x
#   de no chay duoc) nhung trong git no la 100644. Hai hau qua:
#     1. Moi lan pull, exec bit lai mat -> backup hoac phai chmod tay moi lan,
#        hoac gay im lang, khong canh bao gi.
#     2. Working tree khac git nen `git pull` bi chan -> deploy that bai.
#   Dat exec bit trong git la sua goc, server het phai giu thay doi local.
#   (docker-entrypoint.sh va tools/*.sh deu da 100755; deploy/*.sh bi bo sot.)
#
# AN TOAN
#   - Phia server chi dung `git stash` (hoan tac duoc bang `git stash pop`) va
#     `mv` - KHONG dung reset --hard, KHONG xoa gi.
#   - KHONG dung toi 2 volume du lieu.
#   - Khong build, khong restart container. Deploy lam o buoc sau.

$ErrorActionPreference = 'Stop'
$repo   = 'E:\SourceCode\DatabaseManager'
$server = 'mcp-80'          # alias trong ~/.ssh/config -> root@65.108.62.80
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'

# ================================================================ PHAN 1: LOCAL
Write-Host "############ PHAN 1/3: dat exec bit trong git ############"
Set-Location $repo

Write-Host "==> Mode hien tai (mong doi 100644):"
git ls-files -s deploy/backup-data.sh

git update-index --chmod=+x deploy/backup-data.sh
if (-not $?) { throw "git update-index that bai" }

Write-Host "==> Mode sau khi doi (mong doi 100755):"
git ls-files -s deploy/backup-data.sh

$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host "    Khong co gi de commit - exec bit co the da duoc dat tu truoc."
} else {
    Write-Host "==> Commit:"
    $staged

    $msgLines = @(
        'fix(deploy): backup-data.sh phai mang exec bit trong git',
        '',
        'Tren /opt/dbmanager script nay la 100755 vi co nguoi chmod +x de no chay',
        'duoc, trong khi git giu 100644. Moi lan pull, exec bit lai mat: backup',
        'hoac phai chmod tay, hoac gay im lang. Va vi working tree khac git nen',
        '`git pull` bi chan, lam deploy that bai ngay o buoc Git Pull.',
        '',
        'Dat exec bit trong git la sua goc - server khong con can giu thay doi',
        'local. docker-entrypoint.sh va tools/*.sh deu da 100755; deploy/*.sh bi',
        'bo sot.',
        '',
        'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
    )
    $msgFile = Join-Path $env:TEMP 'dbm-execbit-msg.txt'
    [System.IO.File]::WriteAllText($msgFile, ($msgLines -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
    git commit -F $msgFile
    if (-not $?) { throw "git commit that bai" }
    Remove-Item $msgFile -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==> git push origin main"
git push origin main
if (-not $?) { throw "git push that bai - kiem tra PAT GitHub" }

git fetch origin main --quiet
Write-Host "==> local vs remote (mong doi: 0  0)"
git rev-list --left-right --count origin/main...main

# =============================================================== PHAN 2: SERVER
Write-Host ""
Write-Host "############ PHAN 2/3: don working tree tren server ############"

Write-Host "==> Trang thai TRUOC khi don:"
ssh $server 'cd /opt/dbmanager && git status --porcelain'

# tools/ la thu muc untracked se dung do voi thu muc da track trong git.
# Chuyen sang /tmp chu KHONG xoa - neu can co the lay lai.
# git stash cung hoan tac duoc bang `git stash pop`.
$remote = "cd /opt/dbmanager && " +
          "if [ -d tools ]; then mv tools /tmp/dbm-tools-preexisting-$stamp && echo 'da chuyen tools/ sang /tmp'; fi && " +
          "git stash push -u -m 'pre-deploy $stamp' -- .claude/settings.local.json deploy/backup-data.sh || true"

Write-Host "==> Don (mv + stash, deu hoan tac duoc):"
ssh $server $remote

Write-Host ""
Write-Host "==> Trang thai SAU khi don (mong doi: rong):"
ssh $server 'cd /opt/dbmanager && git status --porcelain; echo "--- stash ---"; git stash list | head -3'

# ================================================================= PHAN 3: NEXT
Write-Host ""
Write-Host "############ PHAN 3/3 ############"
Write-Host ""
Write-Host " Neu 'Trang thai SAU khi don' o tren RONG -> quay lai phien Claude"
Write-Host " va noi 'da don xong'. Claude se chay:"
Write-Host '   deploy { server_id: "mcp-80", app_id: "dbmanager" }'
Write-Host ""
Write-Host " Neu can hoan tac phan server:"
Write-Host "   ssh $server 'cd /opt/dbmanager && git stash pop'"
Write-Host "   ssh $server 'mv /tmp/dbm-tools-preexisting-$stamp /opt/dbmanager/tools'"
Write-Host ""
Write-Host " LUU Y sau khi deploy: fix V-02 lam PostgreSQL bat dau dung TLS."
Write-Host " User nao dang noi toi PG server KHONG ho tro TLS se mat ket noi va"
Write-Host " can dat DB_SSL_DISABLED=true. Doi lai, mat khau ho het di cleartext."
