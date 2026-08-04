#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Nightly full-suite regression (H3/H6) — luoi an toan cho chien luoc test theo
  vung anh huong cua /change-pipeline.

.DESCRIPTION
  /change-pipeline chi chay test cua vung bi impact de tiet kiem thoi gian. Rui ro
  con lai: mot regression nam ngoai dependency graph se lot luoi. Script nay chay
  TOAN BO suite mot lan moi dem de bat dung truong hop do.

  Neu full suite FAIL ma cac lan impact-test trong ngay deu PASS => ghi incident
  'test_regression_after_pass' (dung hallucination_flags da khai trong
  agentops.hallucination_flags) va in ra danh sach file nghi ngo de bo sung vao
  core_files cua pipeline-config.yaml.

  C2: danh sach suite + lenh chay doc tu casan-policies.yaml
      (evaluation.regression_suites_required / suite_commands).

.PARAMETER RepoDir
  Thu muc repo. Mac dinh: 3 cap tren script nay.

.PARAMETER Quiet
  Chi in dong tong ket (dung cho scheduled task).

.EXAMPLE
  .\nightly-regression.ps1
  .\nightly-regression.ps1 -Quiet
#>
param(
    [string]$RepoDir = "",
    [switch]$Quiet
)

if (-not $RepoDir) { $RepoDir = (Resolve-Path "$PSScriptRoot\..\..\..").Path }
$PolicyPath = Join-Path $RepoDir ".harness\control\casan-policies.yaml"
if (-not (Test-Path $PolicyPath)) {
    Write-Error "[nightly] khong tim thay casan-policies.yaml tai $PolicyPath"
    exit 1
}

function Write-Info { param([string]$m) if (-not $Quiet) { Write-Host $m } }

# --- Doc suite_commands (C2) ---------------------------------------------
$Suites = [ordered]@{}
$inEval = $false; $inCmds = $false
foreach ($line in (Get-Content -Path $PolicyPath -Encoding utf8)) {
    if ($line -match '^evaluation:') { $inEval = $true; continue }
    if ($inEval -and $line -match '^[a-z_]+:') { break }
    if ($inEval -and $line -match '^\s+suite_commands:') { $inCmds = $true; continue }
    if ($inCmds) {
        if ($line -match '^\s+([a-z0-9_-]+):\s*"([^"]+)"') { $Suites[$matches[1]] = $matches[2] }
        elseif ($line -match '^\s+[a-z_]+:\s*$') { $inCmds = $false }
    }
}
if ($Suites.Count -eq 0) {
    Write-Error "[nightly] khong doc duoc suite_commands tu policy"
    exit 1
}

Write-Info "=== Nightly regression - $(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="
Write-Info "Repo: $RepoDir"
Write-Info "So suite: $($Suites.Count)`n"

# --- Chay tung suite ------------------------------------------------------
$Results = @()
Push-Location $RepoDir
try {
    foreach ($name in $Suites.Keys) {
        $cmd = $Suites[$name]
        Write-Info "[$name] $cmd"
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $out = ""
        try {
            $out = (& cmd /c "$cmd 2>&1" | Out-String)
            $code = $LASTEXITCODE
        } catch {
            $out = "$_"; $code = 1
        }
        $sw.Stop()
        $passed = ($code -eq 0)
        $Results += [pscustomobject]@{
            suite    = $name
            passed   = $passed
            exitcode = $code
            seconds  = [math]::Round($sw.Elapsed.TotalSeconds, 1)
            output   = $out
        }
        Write-Info ("  -> {0} ({1}s)`n" -f $(if ($passed) { "PASS" } else { "FAIL (exit $code)" }), $sw.Elapsed.TotalSeconds.ToString("0.0"))
    }
} finally {
    Pop-Location
}

$Failed = @($Results | Where-Object { -not $_.passed })
$AllPass = ($Failed.Count -eq 0)

# --- Ghi ledger -----------------------------------------------------------
try {
    $LedgerScript = Join-Path $PSScriptRoot "evidence-ledger.ps1"
    if (Test-Path $LedgerScript) {
        $desc = if ($AllPass) {
            "nightly full-suite PASSED ($($Results.Count) suites)"
        } else {
            "nightly full-suite FAILED: $($Failed.suite -join ', ')"
        }
        $entry = @{
            actor  = @{ agent = "nightly-regression"; user = "$env:HARNESS_USER"; session_id = "nightly-$(Get-Date -Format 'yyyyMMdd')"; role = "system" }
            action = @{ type = "pipeline_event"; tool = "nightly-regression"; description = $desc }
            decision = @{
                result     = if ($AllPass) { "allow" } else { "deny" }
                reason     = if ($AllPass) { "all suites green" } else { "test_regression_after_pass" }
                risk_level = if ($AllPass) { "none" } else { "high" }
            }
        } | ConvertTo-Json -Compress -Depth 4
        & $LedgerScript append -EntryJson $entry *>$null
    }
} catch { }

# --- Bao cao --------------------------------------------------------------
Write-Info "=== Ket qua ==="
foreach ($r in $Results) {
    Write-Info ("  {0,-22} {1,-6} {2,6}s" -f $r.suite, $(if ($r.passed) { "PASS" } else { "FAIL" }), $r.seconds)
}

if ($AllPass) {
    Write-Host "[nightly] ALL PASS - $($Results.Count) suites"
    exit 0
}

# Full suite fail => nghi ngo co regression lot luoi impact-test.
Write-Host "[nightly] FAIL: $($Failed.suite -join ', ')" -ForegroundColor Red
Write-Host ""
Write-Host "INCIDENT test_regression_after_pass - da ghi vao ledger." -ForegroundColor Yellow
Write-Host "Neu impact-test trong ngay deu PASS ma full suite FAIL, nghia la co file"
Write-Host "nam NGOAI dependency graph ma test khong lan toi duoc. Xu ly:"
Write-Host "  1. Xem test nao fail o output duoi"
Write-Host "  2. Tim file source lien quan"
Write-Host "  3. Them file do vao core_files trong"
Write-Host "     .claude/skills/change-pipeline/pipeline-config.yaml"
Write-Host ""
foreach ($f in $Failed) {
    Write-Host "--- $($f.suite) (exit $($f.exitcode)) ---" -ForegroundColor Red
    $tail = ($f.output -split "`n" | Select-Object -Last 25) -join "`n"
    Write-Host $tail
    Write-Host ""
}
exit 1
