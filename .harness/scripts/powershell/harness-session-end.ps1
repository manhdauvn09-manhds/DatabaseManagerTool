#!/usr/bin/env pwsh
<#
.SYNOPSIS
  SessionEnd hook — finalises session state, flushes ledger and telemetry.
.DESCRIPTION
  - Flushes any buffered ledger entries
  - Archives session telemetry
  - Cleans up session temp workspace
.NOTES
  Part of Harness Runtime Plane (PEP). Runs at session termination.
#>

$InputJson = $input | Out-String

$HarnessRoot = $env:HARNESS_ROOT
$SessionId = $env:HARNESS_SESSION_ID

if (-not $HarnessRoot) {
    $HarnessRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
}

# H6: sample the whole session's real token usage from the transcript.
# SubagentStop only covers subagents; this covers the main agent.
try {
    $Sampler = Join-Path $PSScriptRoot "agentops-sampler.ps1"
    if ($InputJson.Trim() -and (Test-Path $Sampler)) {
        $InputJson | & $Sampler *>$null
    }
} catch {
    # Sampling is best-effort; never fail session end on it.
}

# Push telemetry to the Control Portal if this checkout is configured for it
# (.harness/portal-sync.json) — the sync path for machines the backend can't
# read (e.g. Windows checkouts). Best-effort, never fails the hook.
try {
    $Pusher = Join-Path $PSScriptRoot "push-telemetry.ps1"
    if (Test-Path $Pusher) { & $Pusher -HarnessRoot $HarnessRoot *>$null }
} catch { }

# Archive session telemetry
$TelemetryDir = "$HarnessRoot\.harness\telemetry"
$SessionLog = "$TelemetryDir\tool-calls.log"
if (Test-Path $SessionLog) {
    $ArchiveFile = "$TelemetryDir\session-$SessionId-$(Get-Date -Format 'yyyyMMddHHmmss').log"
    Copy-Item $SessionLog $ArchiveFile -Force
}

# Cleanup session temp
$SessionTemp = "$HarnessRoot\.harness\tmp\$SessionId"
if (Test-Path $SessionTemp) {
    Remove-Item -Recurse -Force $SessionTemp -ErrorAction SilentlyContinue
}

Write-Output "[harness] Session $SessionId ended at $(Get-Date -Format 'o')"
exit 0
