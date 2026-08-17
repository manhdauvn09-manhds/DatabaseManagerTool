# harness-commit-push.ps1 — commit toàn bộ harness uplift + push lên origin/main
# Chạy:  powershell -File E:\SourceCode\DatabaseManager\harness-commit-push.ps1
# Windows PowerShell 5.1 compatible. Idempotent: chạy lại khi đã sạch thì chỉ push.

$ErrorActionPreference = 'Stop'
$repo = 'E:\SourceCode\DatabaseManager'

Write-Host "==> cd $repo"
Set-Location $repo

Write-Host "==> Nhánh hiện tại:"
git rev-parse --abbrev-ref HEAD

Write-Host ""
Write-Host "==> Số file sẽ được commit:"
$changes = git status --porcelain
if (-not $changes) {
    Write-Host "    (working tree sach - bo qua buoc commit)"
} else {
    ($changes | Measure-Object -Line).Lines
    Write-Host ""
    Write-Host "==> git add -A"
    git add -A
    if (-not $?) { throw "git add that bai" }

    Write-Host "==> git commit"
    # Message di qua FILE, khong qua -m: Windows PowerShell 5.1 dung lai command
    # line cho native exe va tach argument theo dau " nam trong here-string, nen
    # `git commit -m @'...'@` vo message thanh nhieu pathspec va commit that bai.
    $msgLines = @(
        'chore(harness): commit toan bo harness uplift + wire CI gates (C12)',
        '',
        '205 file cua harness/agents/skills dang chi ton tai tren mot may. Commit',
        'de governance khong con phu thuoc vao mot workstation, va de 2 workflow',
        '.github/workflows/tests.yml + harness-gate.yml thuc su chay tren GitHub.',
        '',
        'Truoc commit nay harness doctor bao ci gates la present va triggering on',
        'main - nhung do la file local chua bao gio duoc push, tuc la gate ton tai',
        'ma chua bao gio chay. Theo C12 do la UNPROVEN, khong phai green.',
        '',
        'Kem theo:',
        '- risk-policy.yaml: 3 fix regex (\brm, \b(rm|del)\b, (^|.)-Enc) - rule',
        '  -Enc truoc day khong bao gio chay tren bash vi grep doc - la option.',
        '- .gitignore: bo qua __pycache__/ va *.py[cod] tu .harness/scripts/lib',
        '- xoa 4 file .new da het gia tri sau khi merge',
        '',
        'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
    )
    $msgFile = Join-Path $env:TEMP 'harness-commit-msg.txt'
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($msgFile, ($msgLines -join "`n"), $utf8NoBom)

    git commit -F $msgFile
    if (-not $?) { throw "git commit that bai" }
    Remove-Item $msgFile -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==> git push origin main"
git push origin main
if (-not $?) { throw "git push that bai - kiem tra PAT/credential cua GitHub" }

Write-Host ""
Write-Host "==> Xac minh: local vs remote (mong doi 0  0)"
git fetch origin main --quiet
git rev-list --left-right --count origin/main...main

Write-Host ""
Write-Host "==> Workflow da len remote chua:"
git ls-tree -r origin/main --name-only | Select-String 'workflows/'

Write-Host ""
Write-Host "XONG. Buoc cuoi cung PHAI lam bang tay (C12 - gate phai chung minh da chay):"
Write-Host "  Mo https://github.com/manhdauvn09-manhds/DatabaseManagerTool/actions"
Write-Host "  Xac nhan 'harness-gate' va 'tests' co mot run xanh."
Write-Host "  Chua thay run nao = gate van UNPROVEN, du file da nam tren remote."
