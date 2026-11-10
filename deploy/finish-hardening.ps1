#Requires -Version 5.1
<#
  finish-hardening.ps1 - dong not 3 viec con lai sau dot deploy 2026-08-19.

  MAC DINH LA DRY-RUN: chi in ra se lam gi, KHONG doi gi ca.
  Muon thuc thi thi them -Apply.

      powershell -File E:\SourceCode\DatabaseManager\finish-hardening.ps1
      powershell -File E:\SourceCode\DatabaseManager\finish-hardening.ps1 -Apply

  Chay rieng tung phan (mac dinh chay A + C + D, KHONG chay B):

      -PartA   don stash + tools/ thua tren server
      -PartB   xoa 2 rule UFW catch-all IPv6   <-- doc ky canh bao ben duoi
      -PartC   bat REQUIRE_CLOUDFLARE=true cho DBManager
      -PartD   bao cao dung luong o C: (chi doc, khong xoa)

  CANH BAO PHAN B: dung toi firewall cua may dang chay 12+ site. Script co
  backup /etc/ufw/user*.rules truoc khi doi, va rule SSH (22/tcp v6 + v4) khong
  bi dung toi nen khong co nguy co tu khoa minh ra ngoai. Du vay, HAY GIU MOT
  PHIEN SSH DANG MO trong luc chay, de con duong quay lai neu co gi bat ngo.
#>

[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$PartA,
    [switch]$PartB,
    [switch]$PartC,
    [switch]$PartD
)

$ErrorActionPreference = 'Stop'
$server = 'mcp-80'
$repo   = 'E:\SourceCode\DatabaseManager'

# Khong chi dinh phan nao -> chay A, C, D (B phai xin rieng vi rui ro cao hon).
if (-not ($PartA -or $PartB -or $PartC -or $PartD)) {
    $PartA = $true; $PartC = $true; $PartD = $true
}

$mode = if ($Apply) { "APPLY (se thay doi that)" } else { "DRY-RUN (chi in, khong doi gi)" }
Write-Host ""
Write-Host "=========================================================="
Write-Host " Che do: $mode"
Write-Host "=========================================================="

# QUY TAC QUAN TRONG cho moi $Cmd ben duoi: CHI dung nhay DON, khong bao gio
# dung nhay KEP. Windows PowerShell 5.1 dung lai command line khi goi native exe
# va lam mat cap nhay kep long ben trong, nen `-w "a -> b"` toi curl bien thanh
# mot dau `-` tran va curl bao "option -: is unknown". Nhay don thi song sot.
# He qua: tranh luon dau `|` va khoang trang trong cac chuoi --format cua docker.
function Invoke-Remote {
    param([string]$Desc, [string]$Cmd, [switch]$ReadOnly)
    Write-Host ""
    Write-Host "--- $Desc"
    if ($ReadOnly -or $Apply) {
        ssh $server $Cmd
        # Buoc chi-doc that bai trong luc DRY-RUN khong nen lam dung ca script:
        # no chi la thong tin. Chi buoc ghi that bai moi la loi that su.
        if (-not $?) {
            if ($Apply -and -not $ReadOnly) { throw "That bai: $Desc" }
            Write-Host "    (buoc chi-doc nay loi - bo qua, khong anh huong)"
        }
    } else {
        Write-Host "    [DRY-RUN] se chay tren ${server}:"
        Write-Host "    $Cmd"
    }
}

# ============================================================== PHAN A
if ($PartA) {
    Write-Host ""
    Write-Host "########## PHAN A: don stash + tools/ thua tren server ##########"
    Write-Host ""
    Write-Host "Vi sao an toan: exec bit cua backup-data.sh gio DA nam trong git"
    Write-Host "(commit e328b69), nen noi dung trong stash da thua. tools/ cung da"
    Write-Host "duoc track trong git nen ban copy o /tmp la du."

    Invoke-Remote -ReadOnly -Desc "Kiem tra exec bit da vao git chua (mong doi -rwxr-xr-x)" `
        -Cmd 'ls -l /opt/dbmanager/deploy/backup-data.sh'

    Invoke-Remote -ReadOnly -Desc "Noi dung stash sap bo" `
        -Cmd 'cd /opt/dbmanager && git stash list && git stash show --stat stash@{0} 2>/dev/null'

    Invoke-Remote -Desc "Bo stash" `
        -Cmd 'cd /opt/dbmanager && git stash drop stash@{0}'

    Invoke-Remote -Desc "Bo ban copy tools/ o /tmp" `
        -Cmd 'rm -r /tmp/dbm-tools-preexisting-* 2>/dev/null; echo da-don-xong'
}

# ============================================================== PHAN B
if ($PartB) {
    Write-Host ""
    Write-Host "########## PHAN B: xoa 2 rule UFW catch-all IPv6 ##########"
    Write-Host ""
    Write-Host "Bang chung: mcp.zerocodefee.com khong co AAAA record, va"
    Write-Host "0/1376 request trong nginx access.log den tu IPv6. Duong v6 dang"
    Write-Host "mo nhung khong ai dung -> dung nghia be mat tan cong thua."
    Write-Host ""
    Write-Host "GIU LAI 2 rule IPv4 vi mcp.zerocodefee.com that su can:"
    Write-Host "  - cong 80 cho certbot webroot (LE validate tu IP bat ky)"
    Write-Host "  - cong 443 vi domain do DNS-only, client phai vao thang origin"

    Invoke-Remote -ReadOnly -Desc "Rule hien tai (ghi lai so thu tu)" `
        -Cmd 'ufw status numbered | grep -E certbot\|MCP'

    Invoke-Remote -Desc "Backup rule truoc khi doi" `
        -Cmd 'cp -a /etc/ufw/user.rules /etc/ufw/user.rules.bak-$(date +%Y%m%d-%H%M%S) && cp -a /etc/ufw/user6.rules /etc/ufw/user6.rules.bak-$(date +%Y%m%d-%H%M%S) && ls -l /etc/ufw/*.bak-*'

    # Xoa so LON TRUOC: xoa so nho truoc se lam cac so sau do tut xuong 1 va
    # lenh thu hai se xoa nham rule khac.
    Invoke-Remote -Desc "Xoa rule 46 (443/tcp v6) roi 45 (80/tcp v6) - lon truoc, nho sau" `
        -Cmd 'yes | ufw delete 46 && yes | ufw delete 45'

    Invoke-Remote -ReadOnly -Desc "Kiem tra lai: chi con 2 rule IPv4, SSH van con" `
        -Cmd 'ufw status | grep -E certbot\|MCP\|SSH'

    Invoke-Remote -ReadOnly -Desc "Site van song? (mong doi 200)" `
        -Cmd 'curl -sk -o /dev/null -w HTTP=%{http_code} https://DBManager.allin1site.com/api/health --max-time 10; echo'
}

# ============================================================== PHAN C
if ($PartC) {
    Write-Host ""
    Write-Host "########## PHAN C: bat REQUIRE_CLOUDFLARE=true ##########"
    Write-Host ""
    Write-Host "Da kiem tra truoc: /api/health duoc middleware cho qua TRUOC khi"
    Write-Host "gap gate nay (middleware.ts dong 18 so voi dong 26), nen"
    Write-Host "uptime-kuma goi health qua 127.0.0.1 se KHONG bi 403."
    Write-Host ".env.production la bind-mount read-only tu host -> sua file roi"
    Write-Host "restart la du, KHONG can rebuild image."

    $envPath = '/opt/dbmanager/SecureConnect/.env.production'

    Invoke-Remote -ReadOnly -Desc "Gia tri hien tai" `
        -Cmd "grep -n 'REQUIRE_CLOUDFLARE' $envPath"

    Invoke-Remote -Desc "Backup .env.production (giu nguyen quyen 600)" `
        -Cmd "cp -a $envPath ${envPath}.bak-`$(date +%Y%m%d-%H%M%S) && ls -l ${envPath}*"

    Invoke-Remote -Desc "Doi false -> true" `
        -Cmd "sed -i 's/^REQUIRE_CLOUDFLARE=false/REQUIRE_CLOUDFLARE=true/' $envPath && grep -n 'REQUIRE_CLOUDFLARE' $envPath"

    Invoke-Remote -Desc "Restart app (KHONG dung toi redis, KHONG dung toi volume)" `
        -Cmd 'docker restart dbmanager-app && sleep 8 && docker ps --filter name=dbmanager --format {{.Names}}={{.Status}}'

    Invoke-Remote -ReadOnly -Desc "Verify: qua Cloudflare, /api/health phai 200" `
        -Cmd 'curl -s -o /dev/null -w CF_health=%{http_code} https://DBManager.allin1site.com/api/health --max-time 15; echo'

    Invoke-Remote -ReadOnly -Desc "Verify: goi THANG origin, /app phai bi 403 (day la muc dich cua gate)" `
        -Cmd 'curl -sk -o /dev/null -w origin_app=%{http_code} --resolve DBManager.allin1site.com:443:65.108.62.80 https://DBManager.allin1site.com/app --max-time 10; echo'

    Invoke-Remote -ReadOnly -Desc "Verify: health goi thang van phai 200 (monitor khong duoc gay)" `
        -Cmd 'curl -sk -o /dev/null -w origin_health=%{http_code} --resolve DBManager.allin1site.com:443:65.108.62.80 https://DBManager.allin1site.com/api/health --max-time 10; echo'
}

# ============================================================== PHAN D
if ($PartD) {
    Write-Host ""
    Write-Host "########## PHAN D: bao cao dung luong o C: (CHI DOC) ##########"
    Write-Host ""
    Write-Host "Script nay KHONG xoa gi o phan nay. No chi do va xep hang, de ban"
    Write-Host "quyet dinh. O C: dang 0 GB trong -> dang chan npm ci, build, va"
    Write-Host "npm audit (phan dependency cua bao cao bao mat van con trong)."

    $drive = Get-PSDrive C
    Write-Host ""
    Write-Host ("  Dung: {0} GB   Trong: {1} GB" -f [math]::Round($drive.Used/1GB,1), [math]::Round($drive.Free/1GB,1))

    # PHIEN BAN DAU CUA PHAN NAY DA SAI, va sai theo kieu nguy hiem: no do mot
    # danh sach thu muc DOAN TRUOC (npm cache, Temp, pip...), cong lai duoc 2.1 GB
    # tren mot o dang dung 144 GB - tuc la giai thich duoc 1.5% van de - nhung
    # trinh bay nhu mot bao cao day du. Do dung cai minh doan roi bao cao nhu da
    # do het chinh la loi "khong co du lieu ma hien mau xanh" (C14).
    # Bay gio no QUET THAT: xep hang thu muc theo dung luong, tu goc di xuong.

    Write-Host ""
    Write-Host "  Dang quet that (co the mat 1-3 phut)..."

    function Get-DirSizeGB {
        param([string]$Path)
        $s = (Get-ChildItem $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
              Measure-Object -Property Length -Sum).Sum
        if (-not $s) { return 0 }
        return [math]::Round($s/1GB, 2)
    }

    function Show-Top {
        param([string]$Root, [int]$Take = 10)
        if (-not (Test-Path $Root)) { return }
        Write-Host ""
        Write-Host "  --- $Root"
        Get-ChildItem $Root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
            [PSCustomObject]@{ GB = Get-DirSizeGB $_.FullName; Ten = $_.Name }
        } | Sort-Object GB -Descending | Select-Object -First $Take | Format-Table -AutoSize
    }

    Show-Top -Root 'C:\'                              -Take 8
    Show-Top -Root "$env:USERPROFILE"                 -Take 8
    Show-Top -Root "$env:LOCALAPPDATA"                -Take 8
    Show-Top -Root "$env:APPDATA"                     -Take 8

    Write-Host ""
    Write-Host "  File he thong (thuong bi bo qua):"
    Get-Item C:\hiberfil.sys, C:\pagefile.sys, C:\swapfile.sys -Force -ErrorAction SilentlyContinue |
        Select-Object Name, @{n='GB';e={[math]::Round($_.Length/1GB,2)}} | Format-Table -AutoSize

    Write-Host ""
    Write-Host "  Doc bang tren roi quyet dinh. Vai diem thuong gap tren may nay:"
    Write-Host "    - AppData\Roaming\Claude\vm_bundles : image VM cua Claude Desktop."
    Write-Host "      Xoa duoc, nhung local agent mode se phai tai lai. Khong phai rac."
    Write-Host "    - C:\`$WinREAgent : rac con lai sau Windows Update, xoa an toan."
    Write-Host "    - C:\Windows (WinSxS) : dung cleanmgr, hoac"
    Write-Host "      Dism /Online /Cleanup-Image /StartComponentCleanup"
    Write-Host "    - AppData\Local\Microsoft\OneDrive : coi chung, co the la file dang sync."
    Write-Host ""
    Write-Host "  Script KHONG xoa gi o phan nay. O C: cua ban, ban quyet dinh."
}

Write-Host ""
Write-Host "=========================================================="
if ($Apply) {
    Write-Host " XONG. Quay lai phien Claude va dan output nay."
} else {
    Write-Host " Day moi la DRY-RUN. Chay lai voi -Apply de thuc thi."
    Write-Host " Phan B khong chay mac dinh; muon chay:"
    Write-Host "   powershell -File $repo\finish-hardening.ps1 -PartB -Apply"
}
Write-Host "=========================================================="
