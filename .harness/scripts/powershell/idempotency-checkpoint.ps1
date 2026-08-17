#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Idempotency + Rate-limit Checkpoint (H2) — PreToolUse hook.

.DESCRIPTION
  Tra loi "cau hoi chot" cua H2: neu mot tool call chay 2 lan, he thong co safe khong?

  1. IDEMPOTENCY — tool nam trong tool.idempotency_required, neu da co ban ghi
     THANH CONG voi cung key (tool + input) trong TTL => hoi lai nguoi dung.
  2. RATE LIMIT — dem so lan goi thanh cong trong cua so truot theo
     tool.rate_limits; vuot nguong => hoi lai.

  C2: ca hai deu doc tu .harness/control/casan-policies.yaml.
  C10 (honest): hook chi co the tra "ask" — no KHONG the tra ket qua cache thay
      cho tool. Day la enforcement local, khong thay the gateway PDP. Lan chay
      that su bi chan hay khong la do nguoi quyet dinh o prompt.

  Chi ghi nhan lan chay THANH CONG (idempotency-record.ps1 o PostToolUse), nen
  mot lan fail roi retry se khong bi chan oan.
#>

$InputJson = $input | Out-String
$InputJson = $InputJson.Trim()
if (-not $InputJson) { exit 0 }
try { $CallRecord = $InputJson | ConvertFrom-Json } catch { exit 0 }

$ToolName = if ($CallRecord.tool_name) { $CallRecord.tool_name } else { $CallRecord.tool }
$ToolInput = if ($CallRecord.tool_input) { $CallRecord.tool_input } else { $CallRecord.input }
if (-not $ToolName) { exit 0 }

try {
    . (Join-Path $PSScriptRoot "lib-idempotency.ps1")
} catch { exit 0 }

$HarnessRoot = Get-HarnessRootPath -ScriptRoot $PSScriptRoot
$PolicyPath = Join-Path $HarnessRoot ".harness\control\casan-policies.yaml"
if (-not (Test-Path $PolicyPath)) { exit 0 }

$Required = Get-PolicyList -Path $PolicyPath -Section 'tool' -Key 'idempotency_required'
if ($Required.Count -eq 0) { exit 0 }

$Base = Resolve-IdempotentTool -ToolName $ToolName -Required $Required
if (-not $Base) { exit 0 }
if (-not (Test-IsWriteCall -Base $Base -ToolInput $ToolInput)) { exit 0 }

$Ttl = Get-PolicyScalar -Path $PolicyPath -Section 'tool' -Key 'idempotency_ttl_seconds' -Default 3600
$LockDir = Get-LockStoreDir -HarnessRoot $HarnessRoot
$Key = Get-IdempotencyKey -ToolName $ToolName -ToolInput $ToolInput
$LockFile = Join-Path $LockDir "$Key.hook.json"
$Now = Get-Date

$Reason = $null

# --- 1. Trung key trong TTL? ---------------------------------------------
if (Test-Path $LockFile) {
    try {
        $prev = Get-Content -Path $LockFile -Raw -Encoding utf8 | ConvertFrom-Json
        $age = ($Now - [datetime]$prev.executed_at).TotalSeconds
        if ($age -lt $Ttl) {
            $mins = [math]::Round($age / 60, 1)
            $Reason = "H2 idempotency: '$Base' da chay THANH CONG voi dung input nay cach day $mins phut (key $($Key.Substring(0,12))). Chay lai co the nhan doi side-effect. Xac nhan neu that su muon chay lai."
        }
    } catch {
        Remove-Item -Path $LockFile -Force -ErrorAction SilentlyContinue
    }
}

# --- 2. Rate limit --------------------------------------------------------
if (-not $Reason) {
    try {
        $limitLine = $null
        $inTool = $false; $inLimits = $false
        foreach ($line in (Get-Content -Path $PolicyPath -Encoding utf8)) {
            if ($line -match '^tool:') { $inTool = $true; continue }
            if ($inTool -and $line -match '^[a-z_]+:') { break }
            if ($inTool -and $line -match '^\s+rate_limits:') { $inLimits = $true; continue }
            if ($inLimits -and $line -match "^\s+${Base}:\s*\{\s*per_(minute|hour):\s*(\d+)") {
                $limitLine = @{ unit = $matches[1]; count = [int]$matches[2] }; break
            }
            if ($inLimits -and $line -match '^\s+[a-z_]+:\s*$') { $inLimits = $false }
        }
        if ($limitLine) {
            $windowSec = if ($limitLine.unit -eq 'hour') { 3600 } else { 60 }
            $cutoff = $Now.AddSeconds(-$windowSec)
            $recent = @(Get-ChildItem -Path $LockDir -Filter "*.hook.json" -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -gt $cutoff } |
                ForEach-Object {
                    try { Get-Content $_.FullName -Raw -Encoding utf8 | ConvertFrom-Json } catch { $null }
                } | Where-Object { $_ -and $_.base -eq $Base })
            if ($recent.Count -ge $limitLine.count) {
                $Reason = "H2 rate limit: '$Base' da chay $($recent.Count) lan trong 1 $($limitLine.unit) (nguong $($limitLine.count)). Xac nhan neu that su can chay tiep."
            }
        }
    } catch {
        # Rate limit la best-effort — khong duoc lam hong checkpoint.
    }
}

if (-not $Reason) { exit 0 }

# --- Ghi ledger roi hoi nguoi --------------------------------------------
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
                type        = "decision"
                tool        = "$ToolName"
                description = "idempotency/rate-limit checkpoint triggered for '$Base'"
                input_hash  = $Key
            }
            decision = @{ result = "ask"; reason = "$Reason"; risk_level = "medium" }
        } | ConvertTo-Json -Compress -Depth 4
        & $LedgerScript append -EntryJson $entry *>$null
    }
} catch { }

@{
    hookSpecificOutput = @{
        hookEventName            = "PreToolUse"
        permissionDecision       = "ask"
        permissionDecisionReason = $Reason
    }
} | ConvertTo-Json -Compress -Depth 4

exit 0
