#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Idempotency Recorder (H2) — PostToolUse hook.

.DESCRIPTION
  Ghi lai lan chay THANH CONG cua cac tool trong tool.idempotency_required, de
  idempotency-checkpoint.ps1 (PreToolUse) phat hien duoc lan goi trung sau do.

  Chi ghi khi tool THANH CONG — fail thi khong ghi, nen retry sau khi loi se
  khong bi chan oan.

  File moi (khong sua script cua toolkit) => lan cai dat lai bundle khong ghi de.
#>

$InputJson = $input | Out-String
$InputJson = $InputJson.Trim()
if (-not $InputJson) { exit 0 }
try { $CallRecord = $InputJson | ConvertFrom-Json } catch { exit 0 }

$ToolName = if ($CallRecord.tool_name) { $CallRecord.tool_name } else { $CallRecord.tool }
$ToolInput = if ($CallRecord.tool_input) { $CallRecord.tool_input } else { $CallRecord.input }
if (-not $ToolName) { exit 0 }

# Chi ghi khi thanh cong. Claude Code khong luon gui co success => coi nhu
# thanh cong tru khi co dau hieu loi ro rang.
$Response = $CallRecord.tool_response
if ($null -ne $Response) {
    if ($Response.success -eq $false) { exit 0 }
    if ($Response.error) { exit 0 }
}
if ($CallRecord.tool_success -eq $false) { exit 0 }

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

try {
    $LockDir = Get-LockStoreDir -HarnessRoot $HarnessRoot
    $Key = Get-IdempotencyKey -ToolName $ToolName -ToolInput $ToolInput
    @{
        tool        = $ToolName
        base        = $Base
        key         = $Key
        executed_at = (Get-Date).ToString("o")
        session_id  = "$env:HARNESS_SESSION_ID"
    } | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $LockDir "$Key.hook.json") -Encoding utf8
} catch {
    # Best-effort — khong duoc lam fail hook.
}

exit 0
