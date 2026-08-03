#!/usr/bin/env pwsh

# Append one JSONL line WITHOUT a BOM. `Add-Content -Encoding utf8` on Windows
# PowerShell 5.1 always writes EF BB BF when it creates the file, so the FIRST
# line of a .jsonl becomes unparseable to any reader doing json.loads per line
# (od -c shows 357 273 277 before the opening brace). Reported from a consuming
# project whose test-reports.jsonl could not be read back.
function Add-JsonLine([string]$Path, [string]$Line) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::AppendAllText($Path, $Line + [Environment]::NewLine, $enc)
}

<#
.SYNOPSIS
  PostToolUse hook — records tool call outcomes and updates pipeline context.
.DESCRIPTION
  - Logs completed tool calls to telemetry
  - For side-effect tools, updates the pipeline context file
  - Future: stale context detection via artifact hash comparison
.NOTES
  Part of Harness Runtime Plane (PEP). Reads decision from stdin JSON.
#>

$InputJson = $input | Out-String
if (-not $InputJson) {
    exit 0
}

try {
    $CallRecord = $InputJson | ConvertFrom-Json
} catch {
    # Non-JSON input or empty — silently pass
    exit 0
}

# Extract tool info. Claude Code's PostToolUse payload uses tool_name /
# tool_input / tool_response; accept the older tool/input/result shape too.
$ToolName = if ($CallRecord.tool_name) { $CallRecord.tool_name } else { $CallRecord.tool }
$ToolInput = if ($CallRecord.tool_input) { $CallRecord.tool_input } else { $CallRecord.input }
$ToolResult = if ($CallRecord.tool_response) { $CallRecord.tool_response } else { $CallRecord.result }
$ToolSuccess = $CallRecord.success
$AgentName = if ($CallRecord.agent) { $CallRecord.agent } else { "claude-code" }
$Timestamp = (Get-Date -Format 'o')

# Log to telemetry — resolve path independently (env var not persisted across hook processes)
$_HarnessRoot = $env:HARNESS_ROOT
if (-not $_HarnessRoot) { $_HarnessRoot = Resolve-Path "$PSScriptRoot\..\..\.." }
$TelemetryDir = "$_HarnessRoot\.harness\telemetry"
if (-not (Test-Path $TelemetryDir)) { New-Item -ItemType Directory -Path $TelemetryDir -Force | Out-Null }
$LogFile = "$TelemetryDir\tool-calls.log"

$LogEntry = @{
    timestamp  = $Timestamp
    agent      = $AgentName
    tool       = $ToolName
    success    = $ToolSuccess
    session_id = $env:HARNESS_SESSION_ID
} | ConvertTo-Json -Compress

Add-JsonLine $LogFile $LogEntry

# C9: every side-effect tool call appends one line to the evidence ledger
# (identity + input/output hash). Best-effort — never fail the hook on it.
try {
    $LedgerScript = Join-Path $PSScriptRoot "evidence-ledger.ps1"
    if (Test-Path $LedgerScript) {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $tin  = if ($ToolInput)  { $ToolInput  | ConvertTo-Json -Compress -Depth 6 } else { "{}" }
        $tout = if ($ToolResult) { $ToolResult | ConvertTo-Json -Compress -Depth 6 } else { "{}" }
        $inputHash  = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($tin)))  -replace '-', '').ToLower()
        $outputHash = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($tout))) -replace '-', '').ToLower()
        $entry = @{
            actor = @{ agent = "$AgentName"; user = "$env:HARNESS_USER"; session_id = "$env:HARNESS_SESSION_ID"; role = "member" }
            action = @{ type = "tool_call"; tool = "$ToolName"; description = "completed tool call"; input_hash = $inputHash; output_hash = $outputHash }
            decision = @{ result = "allow"; reason = "completed"; risk_level = "none" }
        } | ConvertTo-Json -Compress -Depth 4
        & $LedgerScript append -EntryJson $entry *>$null
    }
} catch {
    # Swallow — evidence is best-effort; a ledger failure must not fail the hook.
}

exit 0
