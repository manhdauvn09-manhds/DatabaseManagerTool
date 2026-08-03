#!/usr/bin/env pwsh
<#
.SYNOPSIS
  SessionStart hook — initialises per-session state.
  Called once when Claude Code session begins.
.DESCRIPTION
  - Sources harness environment
  - Verifies .harness/ directory integrity
  - Creates session-scoped temp workspace
.NOTES
  Part of Harness Runtime Plane (PEP). Defense-in-depth, bypassable locally.
#>

$HarnessRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$SessionId = [guid]::NewGuid().ToString()

# Verify essential directories exist
$requiredDirs = @(
    "$HarnessRoot\.harness\control",
    "$HarnessRoot\.harness\scripts\powershell",
    "$HarnessRoot\.harness\ledger",
    "$HarnessRoot\.harness\telemetry",
    "$HarnessRoot\contracts"
)
foreach ($dir in $requiredDirs) {
    if (-not (Test-Path $dir)) {
        Write-Warning "[harness-session-start] Missing directory: $dir"
    }
}

# Create session temp workspace
$SessionTemp = "$HarnessRoot\.harness\tmp\$SessionId"
New-Item -ItemType Directory -Path $SessionTemp -Force | Out-Null

# Set session env vars for downstream hooks
$env:HARNESS_SESSION_ID = $SessionId
$env:HARNESS_ROOT = $HarnessRoot
$env:HARNESS_SESSION_START = (Get-Date -Format 'o')

# Issue identity token for the session (D9)
$RolesFile = "$HarnessRoot\.harness\control\session-roles.json"
$GatewayIssuer = "$HarnessRoot\gateway\src\oidc-issuer.py"
if (Test-Path $RolesFile -and (Test-Path $GatewayIssuer)) {
    $DefaultRole = (Get-Content $RolesFile -Raw -Encoding utf8 | ConvertFrom-Json).default_role
    if (-not $DefaultRole) { $DefaultRole = "developer" }
    $TokenJson = & python $GatewayIssuer --agent "session-init" --user "local" --project "harness" --role $DefaultRole --session-id $SessionId 2>$null
    if ($TokenJson) {
        $TokenObj = $TokenJson | ConvertFrom-Json
        $env:HARNESS_AGENT_TOKEN = $TokenObj.token
        Write-Output "[harness] Identity token issued: $($TokenObj.token_id) role=$DefaultRole"
    }
} else {
    Write-Output "[harness] No identity config — running without JWT (D9 bypassed)"
}

# H1 — build/refresh the pipeline-context pointer store (best-effort).
$ContextBuild = "$PSScriptRoot\harness-context-build.ps1"
if (Test-Path $ContextBuild) {
    try { & $ContextBuild -HarnessRoot $HarnessRoot } catch { Write-Warning "[harness] context build skipped: $_" }
}

Write-Output "[harness] Session $SessionId started at $env:HARNESS_SESSION_START"
