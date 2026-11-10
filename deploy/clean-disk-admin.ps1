#Requires -Version 5.1
<#
  clean-disk-admin.ps1 - don o C: phan CAN QUYEN ADMINISTRATOR.

  CHAY BANG POWERSHELL ADMIN:
    1. Bam Start, go "powershell"
    2. Chuot phai -> "Run as administrator"
    3. Dan lenh:
       powershell -File E:\SourceCode\DatabaseManager\clean-disk-admin.ps1

  Phan khong can admin (npm cache, user temp) DA don roi: +0.9 GB.

  Script nay KHONG dung toi:
    - claudevm.bundle (10.5 GB) - do la image VM cua Claude Desktop, xoa thi
      local agent mode phai tai lai. Do la lua chon cua ban, khong phai rac.
    - OneDrive - co the la file dang sync, khong phai cache.
    - Bat ky file du lieu ca nhan nao.
#>

$ErrorActionPreference = 'Continue'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host ""
    Write-Host "  CAN QUYEN ADMINISTRATOR." -ForegroundColor Yellow
    Write-Host "  Mo PowerShell bang 'Run as administrator' roi chay lai."
    Write-Host ""
    exit 1
}

function Show-Free { param([string]$Nhan)
    $g = [math]::Round((Get-PSDrive C).Free/1GB, 2)
    Write-Host ("  [{0}] C: trong = {1} GB" -f $Nhan, $g)
    return (Get-PSDrive C).Free
}

Write-Host ""
Write-Host "=========================================================="
$start = Show-Free 'bat dau'
Write-Host "=========================================================="

# ---------------------------------------------------------- 1. Windows Temp
Write-Host ""
Write-Host "--- 1/4: C:\Windows\Temp (file dang bi khoa se tu dong bo qua)"
$n = 0; $skip = 0
Get-ChildItem "$env:SystemRoot\Temp" -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop; $n++ } catch { $skip++ }
}
Write-Host ("    xoa $n muc, bo qua $skip")
$null = Show-Free 'sau buoc 1'

# ---------------------------------------------------------- 2. $WinREAgent
# Thu muc staging con lai sau khi Windows Update chay xong. Microsoft de lai
# de rollback, nhung khi ban update da on dinh tu lau thi no chi la rac.
Write-Host ""
Write-Host '--- 2/4: C:\$WinREAgent (rac staging cua Windows Update)'
if (Test-Path 'C:\$WinREAgent') {
    try {
        Remove-Item 'C:\$WinREAgent' -Recurse -Force -ErrorAction Stop
        Write-Host "    da xoa"
    } catch {
        Write-Host "    khong xoa duoc: $($_.Exception.Message)"
    }
} else {
    Write-Host "    khong ton tai (co the da don truoc do)"
}
$null = Show-Free 'sau buoc 2'

# ---------------------------------------------------------- 3. DISM
# Day thuong la khoan lon nhat: WinSxS giu lai moi phien ban cu cua component
# sau mot thoi gian dai update. StartComponentCleanup bo cac ban thay the.
# ResetBase manh tay hon (bo luon kha nang go update cu) - KHONG dung o day,
# vi doi lai vai GB ma mat duong lui khong phai danh doi tot.
Write-Host ""
Write-Host "--- 3/4: DISM component cleanup (WinSxS) - buoc nay CHAM, 5-20 phut"
Write-Host "    dang chay, dung dong cua so..."
Dism.exe /Online /Cleanup-Image /StartComponentCleanup
Write-Host ("    DISM exit code = {0}" -f $LASTEXITCODE)
$null = Show-Free 'sau buoc 3'

# ---------------------------------------------------------- 4. Recycle Bin
Write-Host ""
Write-Host "--- 4/4: Thung rac"
try {
    Clear-RecycleBin -DriveLetter C -Force -ErrorAction Stop
    Write-Host "    da don"
} catch {
    Write-Host "    bo qua (rong san hoac khong truy cap duoc)"
}

# ---------------------------------------------------------- Tong ket
$end = (Get-PSDrive C).Free
Write-Host ""
Write-Host "=========================================================="
Write-Host ("  Truoc : {0} GB" -f [math]::Round($start/1GB,2))
Write-Host ("  Sau   : {0} GB" -f [math]::Round($end/1GB,2))
Write-Host ("  Thu ve: {0} GB" -f [math]::Round(($end-$start)/1GB,2))
Write-Host "=========================================================="
Write-Host ""
Write-Host "  Neu van chua du cho, don bay lon nhat con lai la:"
Write-Host "    AppData\Roaming\Claude\vm_bundles\claudevm.bundle = 10.5 GB"
Write-Host "  Xoa duoc, nhung local agent mode cua Claude Desktop se phai tai"
Write-Host "  lai tu dau. Day khong phai rac - can ban quyet dinh, khong nen"
Write-Host "  xoa chi vi no to."
Write-Host ""
Write-Host "  Mot lua chon sach hon: chay 'cleanmgr' va chon"
Write-Host "  'Windows Update Cleanup' + 'Delivery Optimization Files'."
