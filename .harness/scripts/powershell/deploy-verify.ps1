#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Post-deploy verification / transaction boundary (H7) — PostToolUse hook.

.DESCRIPTION
  Deploy xong => tu chay smoke check. Fail => BLOCK va yeu cau rollback ngay,
  dong thoi ghi incident vao hash-chain ledger.

  Dap ung "cau hoi chot" cua H7: neu buoc sau fail sau khi buoc truoc da chay,
  pipeline co recover duoc khong.

  C2: URL / chuoi mong doi / so lan retry doc tu casan-policies.yaml
      (orchestration.transaction.*), khong hardcode.
  C10 (honest enforcement): hook PHAT HIEN loi va CHAN luong lai. No KHONG tu
      goi rollback_deploy duoc — hook khong co quyen goi MCP tool. Viec rollback
      do agent/nguoi thuc hien sau khi doc canh bao nay. Dung coi day la
      auto-rollback day du.
#>

$InputJson = $input | Out-String
$InputJson = $InputJson.Trim()
if (-not $InputJson) { exit 0 }
try { $CallRecord = $InputJson | ConvertFrom-Json } catch { exit 0 }

$ToolName = if ($CallRecord.tool_name) { $CallRecord.tool_name } else { $CallRecord.tool }
if (-not $ToolName) { exit 0 }

# Chi quan tam den deploy (khong phai rollback_deploy — rollback fail thi da co
# canh bao rieng, va chay smoke sau rollback se gay vong lap canh bao).
if ($ToolName -notlike "*deploy" -or $ToolName -like "*rollback_deploy") { exit 0 }
if ($ToolName -like "*deploy_safe") { } # deploy_safe van verify binh thuong

$HarnessRoot = $env:HARNESS_ROOT
if (-not $HarnessRoot) { $HarnessRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path }
$PolicyPath = Join-Path $HarnessRoot ".harness\control\casan-policies.yaml"
if (-not (Test-Path $PolicyPath)) { exit 0 }

# --- Doc orchestration.transaction.* (C2) --------------------------------
$SmokeUrl = $null; $Expect = "ok"; $Timeout = 20; $Retries = 3; $Delay = 5
try {
    $inOrch = $false
    foreach ($line in (Get-Content -Path $PolicyPath -Encoding utf8)) {
        if ($line -match '^orchestration:') { $inOrch = $true; continue }
        if ($inOrch -and $line -match '^[a-z_]+:') { break }
        if (-not $inOrch) { continue }
        if ($line -match '^\s+smoke_url:\s*"([^"]+)"')            { $SmokeUrl = $matches[1] }
        elseif ($line -match '^\s+smoke_expect:\s*"([^"]*)"')     { $Expect = $matches[1] }
        elseif ($line -match '^\s+smoke_timeout_seconds:\s*(\d+)'){ $Timeout = [int]$matches[1] }
        elseif ($line -match '^\s+smoke_retries:\s*(\d+)')        { $Retries = [int]$matches[1] }
        elseif ($line -match '^\s+smoke_retry_delay_seconds:\s*(\d+)') { $Delay = [int]$matches[1] }
    }
} catch { exit 0 }

if (-not $SmokeUrl) { exit 0 }   # chua cau hinh => khong lam gi

# --- Smoke check, co retry (container can vai giay de len) ---------------
$Ok = $false
$LastErr = ""
for ($i = 1; $i -le $Retries; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri $SmokeUrl -TimeoutSec $Timeout -UseBasicParsing
        $body = "$($resp.Content)"
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300 -and (-not $Expect -or $body -match [regex]::Escape($Expect))) {
            $Ok = $true; break
        }
        $LastErr = "HTTP $($resp.StatusCode), body khong chua '$Expect'"
    } catch {
        $LastErr = $_.Exception.Message
    }
    if ($i -lt $Retries) { Start-Sleep -Seconds $Delay }
}

# --- Ghi ledger ----------------------------------------------------------
try {
    $LedgerScript = Join-Path $PSScriptRoot "evidence-ledger.ps1"
    if (Test-Path $LedgerScript) {
        $entry = @{
            actor = @{
                agent      = "$env:HARNESS_AGENT_NAME"
                user       = "$env:HARNESS_USER"
                session_id = "$env:HARNESS_SESSION_ID"
                role       = "member"
            }
            action = @{
                type        = "pipeline_event"
                tool        = "$ToolName"
                description = if ($Ok) { "post-deploy smoke check PASSED ($SmokeUrl)" } else { "post-deploy smoke check FAILED ($SmokeUrl): $LastErr" }
            }
            decision = @{
                result     = if ($Ok) { "allow" } else { "deny" }
                reason     = if ($Ok) { "healthy" } else { "$LastErr" }
                risk_level = if ($Ok) { "none" } else { "critical" }
            }
        } | ConvertTo-Json -Compress -Depth 4
        & $LedgerScript append -EntryJson $entry *>$null
    }
} catch { }

if ($Ok) { exit 0 }

# --- Fail => chan luong lai, buoc agent xu ly ----------------------------
@{
    decision = "block"
    reason   = "H7 TRANSACTION BOUNDARY: deploy xong nhung smoke check FAIL sau $Retries lan thu.`n" +
               "URL : $SmokeUrl`n" +
               "Loi : $LastErr`n`n" +
               "Production co the dang HONG. Hanh dong bat buoc ngay:`n" +
               "  1. Goi rollback_deploy (server_id mcp-80, app_id dbmanager)`n" +
               "  2. Xac nhan lai health sau rollback`n" +
               "  3. Bao nguoi dung nguyen nhan truoc khi deploy lai`n" +
               "KHONG duoc bo qua canh bao nay va lam viec khac."
} | ConvertTo-Json -Compress

exit 0
