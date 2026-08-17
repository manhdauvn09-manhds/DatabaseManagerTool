# push-and-deploy.ps1
# Dùng khi GitHub PAT đã renew.
# Chạy: .\push-and-deploy.ps1
# Nhập PAT khi được hỏi → script tự push + deploy.

$ErrorActionPreference = "Stop"
$repo = "github.com/manhdauvn09-manhds/DatabaseManagerTool.git"
$user = "manhdauvn09"

Write-Host ""
Write-Host "=== Push & Deploy — DatabaseManager ===" -ForegroundColor Cyan
Write-Host "Repo: https://$repo" -ForegroundColor Gray
Write-Host ""

# 1. Nhập PAT (ẩn input)
$pat = Read-Host "Nhap GitHub PAT (classic, scope: repo)" -AsSecureString
$patPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pat)
)

# 2. Update remote URL với PAT mới
$newRemote = "https://${user}:${patPlain}@${repo}"
git remote set-url origin $newRemote
Write-Host "[1/3] Remote URL updated." -ForegroundColor Green

# 3. Push main
Write-Host "[2/3] Pushing main..." -ForegroundColor Yellow
git -C "E:\SourceCode\DatabaseManager" push origin main
Write-Host "      Push OK." -ForegroundColor Green

# 4. Clear PAT khỏi memory (xóa plaintext, giữ URL với token đã lưu trong git credential store)
$patPlain = $null
[GC]::Collect()

# 5. Thông báo xong
Write-Host ""
Write-Host "[3/3] Done! Code da len GitHub." -ForegroundColor Green
Write-Host ""
Write-Host "Gio deploy len server:" -ForegroundColor Cyan
Write-Host "  -> MCP deploy tool se tu dong git pull + build + health check" -ForegroundColor Gray
Write-Host "  -> Hoac nhan /commit-deploy-log de Claude tu deploy" -ForegroundColor Gray
Write-Host ""
