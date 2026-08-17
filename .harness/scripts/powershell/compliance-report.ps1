#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Compliance report generator (H5) — sinh bao cao tu hash-chain ledger.

.DESCRIPTION
  casan-policies.yaml khai `governance.compliance_report: "monthly"` nhung toolkit
  KHONG ship tool nao sinh bao cao => muc checklist do khong project nao tick duoc.
  Script nay dong gap do.

  Bao cao tra loi dung cau audit cua H5: "ai da lam gi, luc may gio, duoc ai duyet".

  Nguon du lieu:
    .harness/ledger/chain.jsonl      - tool call, approval, decision, pipeline event
    .harness/telemetry/daily-*.jsonl - token/cost per session (H6)

  Luon verify chain truoc khi bao cao — bao cao dua tren ledger da bi sua la vo nghia.

.PARAMETER Month
  Thang can bao cao, dang yyyy-MM. Mac dinh: thang hien tai.

.PARAMETER OutFile
  Duong dan file .md xuat ra. Mac dinh: docs/compliance-<yyyyMM>.md

.EXAMPLE
  .\compliance-report.ps1
  .\compliance-report.ps1 -Month 2026-07
#>
param(
    [string]$Month = "",
    [string]$OutFile = "",
    [string]$RepoDir = ""
)

if (-not $RepoDir) { $RepoDir = (Resolve-Path "$PSScriptRoot\..\..\..").Path }
if (-not $Month)   { $Month = Get-Date -Format "yyyy-MM" }
if ($Month -notmatch '^\d{4}-\d{2}$') { Write-Error "[compliance] -Month phai dang yyyy-MM"; exit 1 }
if (-not $OutFile) { $OutFile = Join-Path $RepoDir "docs\compliance-$($Month -replace '-','').md" }

$LedgerPath = Join-Path $RepoDir ".harness\ledger\chain.jsonl"
if (-not (Test-Path $LedgerPath)) {
    Write-Error "[compliance] chua co ledger tai $LedgerPath - chua co gi de bao cao"
    exit 1
}

# --- 1. Verify chain TRUOC khi bao cao ------------------------------------
$ChainStatus = "UNKNOWN"
try {
    $verifyOut = & (Join-Path $PSScriptRoot "evidence-ledger.ps1") verify 2>&1 | Out-String
    $ChainStatus = if ($verifyOut -match "INTACT") { "INTACT" } else { "BROKEN" }
} catch { $ChainStatus = "UNKNOWN" }

# --- 2. Doc entry trong thang --------------------------------------------
$All = @()
foreach ($line in (Get-Content -Path $LedgerPath -Encoding utf8)) {
    if (-not $line.Trim()) { continue }
    try { $All += ($line | ConvertFrom-Json) } catch { }
}
$Entries = @($All | Where-Object { $_.timestamp -and $_.timestamp.StartsWith($Month) })

# --- 3. Thong ke ----------------------------------------------------------
$ByType     = $Entries | Group-Object { $_.action.type }     | Sort-Object Count -Descending
$ByResult   = $Entries | Group-Object { $_.decision.result } | Sort-Object Count -Descending
$ByTool     = $Entries | Group-Object { $_.action.tool }     | Sort-Object Count -Descending
$ByActor    = $Entries | Group-Object { $_.actor.user }      | Sort-Object Count -Descending
$Approvals  = @($Entries | Where-Object { $_.action.type -eq 'approval' })
$Denied     = @($Entries | Where-Object { $_.decision.result -eq 'deny' })
$HighRisk   = @($Entries | Where-Object { $_.decision.risk_level -in @('high','critical') })

# --- 4. Cost tu telemetry (H6) -------------------------------------------
$CostUsd = 0.0; $TokIn = 0; $TokOut = 0; $Sessions = 0
Get-ChildItem (Join-Path $RepoDir ".harness\telemetry") -Filter "daily-*.jsonl" -ErrorAction SilentlyContinue | ForEach-Object {
    foreach ($line in (Get-Content $_.FullName -Encoding utf8)) {
        if (-not $line.Trim()) { continue }
        try {
            $t = $line.TrimStart([char]0xFEFF) | ConvertFrom-Json
            if ($t.timestamp -and $t.timestamp.StartsWith($Month)) {
                $CostUsd += [double]$t.estimated_cost_usd
                $TokIn   += [int]$t.tokens_in
                $TokOut  += [int]$t.tokens_out
                $Sessions++
            }
        } catch { }
    }
}

# --- 5. Sinh markdown -----------------------------------------------------
$nl = [Environment]::NewLine
$sb = New-Object System.Text.StringBuilder
function Add-Line { param([string]$t = "") [void]$sb.AppendLine($t) }

Add-Line "# Compliance Report - $Month"
Add-Line ""
Add-Line "> Sinh tu dong boi ``.harness/scripts/powershell/compliance-report.ps1`` luc $(Get-Date -Format 'yyyy-MM-dd HH:mm')."
Add-Line "> Nguon: hash-chain ledger (H5) + telemetry (H6). Khong sua tay."
Add-Line ""
Add-Line "## 1. Tinh toan ven cua ledger"
Add-Line ""
$icon = if ($ChainStatus -eq "INTACT") { "OK" } else { "CANH BAO" }
Add-Line "| | |"
Add-Line "|---|---|"
Add-Line "| Trang thai chain | **$ChainStatus** ($icon) |"
Add-Line "| Tong entry (toan bo) | $($All.Count) |"
Add-Line "| Entry trong thang | $($Entries.Count) |"
Add-Line ""
if ($ChainStatus -ne "INTACT") {
    Add-Line "> **CANH BAO:** hash-chain khong toan ven. Bao cao nay KHONG dang tin cay."
    Add-Line ""
}

Add-Line "## 2. Ai da lam gi"
Add-Line ""
if ($ByActor.Count -eq 0) { Add-Line "_Khong co hoat dong trong thang._" }
else {
    Add-Line "| Nguoi dung | So action |"
    Add-Line "|---|---|"
    foreach ($g in $ByActor) { Add-Line "| $(if ($g.Name) { $g.Name } else { '(khong ghi nhan)' }) | $($g.Count) |" }
}
Add-Line ""

Add-Line "## 3. Phan loai action"
Add-Line ""
Add-Line "| Loai | So luong |"
Add-Line "|---|---|"
foreach ($g in $ByType) { Add-Line "| $($g.Name) | $($g.Count) |" }
Add-Line ""
Add-Line "| Ket qua | So luong |"
Add-Line "|---|---|"
foreach ($g in $ByResult) { Add-Line "| $($g.Name) | $($g.Count) |" }
Add-Line ""

Add-Line "## 4. Phe duyet (approval)"
Add-Line ""
if ($Approvals.Count -eq 0) { Add-Line "_Khong co action nao can phe duyet trong thang._" }
else {
    Add-Line "| Thoi diem | Tool | Nguoi | Ly do |"
    Add-Line "|---|---|---|---|"
    foreach ($a in $Approvals) {
        Add-Line "| $($a.timestamp.Substring(0,19)) | $($a.action.tool) | $($a.actor.user) | $($a.decision.reason) |"
    }
    Add-Line ""
    Add-Line "> Luu y: entry ghi lai luc HOI phe duyet. Ket qua cuoi (nguoi bam dong y hay khong)"
    Add-Line "> nam o prompt cua Claude Code, chua duoc ghi nguoc lai ledger - day la gap con lai cua H5."
}
Add-Line ""

Add-Line "## 5. Action bi tu choi / rui ro cao"
Add-Line ""
Add-Line "- Bi tu choi (deny): **$($Denied.Count)**"
Add-Line "- Rui ro high/critical: **$($HighRisk.Count)**"
Add-Line ""
if ($HighRisk.Count -gt 0) {
    # Gom theo input_hash: hook self-test cua toolkit (test-hooks.ps1) lap lai y het
    # input moi lan chay, se thoi phong thanh hang chuc "su co" neu liet ke tho.
    $Grouped = $HighRisk | Group-Object { $_.action.input_hash } | Sort-Object Count -Descending
    Add-Line "| Lan dau | Lan cuoi | So lan | Tool | Muc | Mo ta |"
    Add-Line "|---|---|---|---|---|---|"
    foreach ($g in ($Grouped | Select-Object -First 30)) {
        $ts = $g.Group | Sort-Object timestamp
        $first = $ts[0]; $last = $ts[-1]
        Add-Line "| $($first.timestamp.Substring(0,19)) | $($last.timestamp.Substring(0,19)) | $($g.Count) | $($first.action.tool) | $($first.decision.risk_level) | $($first.action.description) |"
    }
    Add-Line ""
    Add-Line "> **Doc bang nay the nao:** cung mot ``input_hash`` lap lai nhieu lan thuong la"
    Add-Line "> hook self-test cua toolkit (``test-hooks.ps1`` co chu dich gui ``rm -rf``,"
    Add-Line "> ``git push --force``... de kiem tra guard con song). Do KHONG phai cong viec"
    Add-Line "> that bi chan. Su co that la nhung dong co **So lan = 1** va mo ta gan voi"
    Add-Line "> viec dang lam. Con **$($Grouped.Count)** nhom khac nhau tren tong $($HighRisk.Count) entry."
    Add-Line ""
}

Add-Line "## 6. Tool duoc goi nhieu nhat"
Add-Line ""
if ($ByTool.Count -eq 0) { Add-Line "_Khong co du lieu._" }
else {
    Add-Line "| Tool | So lan |"
    Add-Line "|---|---|"
    foreach ($g in ($ByTool | Select-Object -First 15)) { Add-Line "| $($g.Name) | $($g.Count) |" }
}
Add-Line ""

Add-Line "## 7. Chi phi agent (H6)"
Add-Line ""
Add-Line "| | |"
Add-Line "|---|---|"
Add-Line "| Session | $Sessions |"
Add-Line "| Token in | $('{0:N0}' -f $TokIn) |"
Add-Line "| Token out | $('{0:N0}' -f $TokOut) |"
Add-Line "| Chi phi uoc tinh | `$$('{0:N2}' -f $CostUsd) |"
Add-Line ""
Add-Line "---"
Add-Line ""
Add-Line "_Bao cao nay dap ung ``governance.compliance_report: monthly`` trong casan-policies.yaml._"

$OutDir = Split-Path -Parent $OutFile
if ($OutDir -and -not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$sb.ToString() | Set-Content -Path $OutFile -Encoding utf8

Write-Host "[compliance] Da sinh: $OutFile"
Write-Host "[compliance] Chain: $ChainStatus | Entry trong thang: $($Entries.Count) | Approval: $($Approvals.Count) | High/critical: $($HighRisk.Count)"
exit 0
