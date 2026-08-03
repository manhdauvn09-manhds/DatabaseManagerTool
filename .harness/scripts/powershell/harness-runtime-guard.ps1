#!/usr/bin/env pwsh
<#
.SYNOPSIS
  PreToolUse hook — Runtime Guard (H4). PEP for side-effect prevention.
.DESCRIPTION
  Reads risk-policy.yaml (SSOT) to decide allow/deny for each tool call.
  Reads stdin JSON { tool, input, ... } from Claude Code PreToolUse hook.
  Returns:
    - exit 0: allow (no match found)
    - exit 2: deny (match found, hard stop)
    - JSON with permissionDecision: "deny" on stdout for soft denial
.NOTES
  C2: Reads YAML config — never hardcode deny rules in this script.
  C10: Local hook is defense-in-depth; high-risk actions need server-side PDP.
#>

$InputJson = $input | Out-String
$InputJson = $InputJson.Trim()
if (-not $InputJson) {
    exit 0
}

try {
    $CallRecord = $InputJson | ConvertFrom-Json
} catch {
    exit 0
}

# Claude Code's PreToolUse payload uses tool_name / tool_input; accept the
# older tool / input shape too.
$ToolName = if ($CallRecord.tool_name) { $CallRecord.tool_name } else { $CallRecord.tool }
$ToolInput = if ($CallRecord.tool_input) { $CallRecord.tool_input } else { $CallRecord.input }

# Resolve harness root
$HarnessRoot = $env:HARNESS_ROOT
if (-not $HarnessRoot) {
    $HarnessRoot = Resolve-Path "$PSScriptRoot\..\..\.."
}

# Load risk policy from YAML (SSOT — C2)
$RiskPolicyPath = "$HarnessRoot\.harness\control\risk-policy.yaml"
if (-not (Test-Path $RiskPolicyPath)) {
    # No policy file = permissive mode (fail-open for read)
    exit 0
}

try {
    $RawYaml = Get-Content -Path $RiskPolicyPath -Raw -Encoding utf8
    # Simple YAML parsing: extract all `- pattern: "..."` entries
    $DenyPatterns = @()
    foreach ($line in $RawYaml -split "`n") {
        if ($line.Trim() -match '^-\s+pattern:\s+"(.+)"$') {
            # Unescape YAML double-backslash to single backslash for regex
            $pattern = $matches[1] -replace '\\\\', '\'
            $DenyPatterns += $pattern
        }
    }
} catch {
    Write-Warning "[harness-runtime-guard] Cannot read risk-policy.yaml: $_"
    exit 0
}

# Build command string from tool input for pattern matching.
# Command deny-patterns describe SHELL COMMANDS, so only read the command/script
# fields. Do NOT fall back to serializing the whole tool-input JSON: for Write/
# Edit that is file CONTENT, and scanning documentation/source text against
# shell-command regexes produced false positives (a file that merely quotes a
# dangerous one-liner is not executing it). Non-command tools are still governed
# by tool-registry risk levels below (deny-by-default for registered side-effects).
$CommandString = ""
if ($ToolInput) {
    if ($ToolInput.command) { $CommandString = [string]$ToolInput.command }
    elseif ($ToolInput.script) { $CommandString = [string]$ToolInput.script }
}

# Security-event logging helper (H4) -- dot-source once, defensive.
$GuardLibPath = Join-Path $PSScriptRoot "lib-security-log.ps1"
if (Test-Path $GuardLibPath) { . $GuardLibPath }

# C9: persist a deny entry to the evidence ledger (chain.jsonl) so the Portal
# blocked-count reflects real guard denies. Best-effort — a ledger failure must
# never change the guard verdict.
function Write-LedgerDeny {
    param([string]$Tool, [string]$Pattern, [string]$Command)
    try {
        $LedgerScript = Join-Path $PSScriptRoot "evidence-ledger.ps1"
        if (-not (Test-Path $LedgerScript)) { return }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $inputHash = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("$Command"))) -replace '-', '').ToLower()
        $entry = @{
            actor = @{ agent = "claude-code"; user = "$env:HARNESS_USER"; session_id = "$env:HARNESS_SESSION_ID"; role = "member" }
            action = @{ type = "tool_call"; tool = $Tool; description = "blocked by runtime guard"; input_hash = $inputHash; output_hash = "" }
            decision = @{ result = "deny"; reason = "deny pattern: $Pattern"; risk_level = "high" }
        } | ConvertTo-Json -Compress -Depth 4
        & $LedgerScript append -EntryJson $entry *>$null
    } catch {
        # Swallow — evidence is best-effort, verdict is not.
    }
}

# Check command deny patterns. A single malformed regex must never brick the
# developer's shell -- match inside try/catch and skip a pattern that won't
# compile (fail-open per pattern; the rest still enforce).
foreach ($pattern in $DenyPatterns) {
    $isMatch = $false
    try { $isMatch = ($CommandString -match $pattern) } catch { continue }
    if ($isMatch) {
        $DenyReason = "Command matched deny pattern: $pattern"
        Write-Warning "[harness-runtime-guard] DENIED: $DenyReason"

        if (Get-Command Write-SecurityEvent -ErrorAction SilentlyContinue) {
            $cmdSnip = $CommandString.Substring(0, [Math]::Min($CommandString.Length, 240))
            Write-SecurityEvent -HarnessRoot $HarnessRoot -Type "guard_block" -Severity "high" `
                -Category $ToolName -DetectedBy "harness-runtime-guard" `
                -Excerpt "blocked command: `"$cmdSnip`" | matched deny-pattern: $pattern"
        }
        Write-LedgerDeny -Tool $ToolName -Pattern $pattern -Command $CommandString

        # Output JSON for PreToolUse permission decision
        $Decision = @{
            permissionDecision = "deny"
            reason = $DenyReason
            tool = $ToolName
        } | ConvertTo-Json -Compress
        Write-Output $Decision

        # Exit 2 signals hard deny to Claude Code
        exit 2
    }
}

# Check tool-level deny defaults for non-Bash tools
$ToolDenyPath = "$HarnessRoot\.harness\control\tool-registry.json"
if (Test-Path $ToolDenyPath) {
    try {
        $ToolRegistry = Get-Content -Path $ToolDenyPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($ToolRegistry.tools.$ToolName) {
            $ToolEntry = $ToolRegistry.tools.$ToolName
            if ($ToolEntry.risk_level -in @("high", "critical") -and $ToolEntry.default_action -eq "deny") {
                $DenyReason = "Tool '$ToolName' has risk level '$($ToolEntry.risk_level)' — deny-by-default"
                Write-Warning "[harness-runtime-guard] DENIED: $DenyReason"
                if (Get-Command Write-SecurityEvent -ErrorAction SilentlyContinue) {
                    Write-SecurityEvent -HarnessRoot $HarnessRoot -Type "guard_block" -Severity $ToolEntry.risk_level `
                        -Category $ToolName -DetectedBy "harness-runtime-guard" `
                        -Excerpt "blocked tool '$ToolName' | reason: deny-by-default (risk=$($ToolEntry.risk_level)) in tool-registry"
                }
                Write-LedgerDeny -Tool $ToolName -Pattern "deny-by-default ($($ToolEntry.risk_level))" -Command $CommandString
                $Decision = @{
                    permissionDecision = "deny"
                    reason = $DenyReason
                    tool = $ToolName
                } | ConvertTo-Json -Compress
                Write-Output $Decision
                exit 2
            }
        }
    } catch {
        # Tool registry not available or parse error — permissive
    }
}

# --- Server-side PDP consult (H4 outbound allowlist + H5 approval workflow) ---
# Opt-in: only when .harness/portal-sync.json sets "pdp_enforce": true. The
# decision lives on the Portal; the hook honors deny/ask. Best-effort/fail-open
# on any network error (C10: this is defense-in-depth + a server decision, not a
# hard boundary — hard enforcement needs the tool path itself routed via the PDP).
try {
    $SyncCfgPath = "$HarnessRoot\.harness\portal-sync.json"
    if ((Test-Path $SyncCfgPath) -and $CommandString) {
        $SyncCfg = Get-Content -Path $SyncCfgPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($SyncCfg.pdp_enforce -eq $true -and $SyncCfg.portal_url -and $SyncCfg.project_id) {
            # Only consult for high-risk shapes to avoid latency on ordinary calls.
            $HighRisk = ($CommandString -match '(?i)\b(curl|wget|Invoke-WebRequest|iwr|nc|ncat|http_fetch|deploy|docker\s+compose\s+up|drop\s+table|truncate\s+table|delete\s+from|alter\s+table)\b') `
                -or ($ToolName -in @('deploy','rollback_deploy','mysql_query','exec_in_container','http_fetch'))
            if ($HighRisk) {
                $Key = $env:HARNESS_PORTAL_INGEST_KEY
                if (-not $Key) {
                    $KeyFile = "$HarnessRoot\.harness\portal-sync.key"
                    if (Test-Path $KeyFile) { $Key = (Get-Content -Path $KeyFile -Raw).Trim() }
                }
                if ($Key) {
                    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
                    $Url = "$($SyncCfg.portal_url.TrimEnd('/'))/api/pdp/$($SyncCfg.project_id)/decide"
                    $Body = @{ tool = "$ToolName"; command = "$CommandString"; actor = "$env:HARNESS_SESSION_ID" } | ConvertTo-Json -Compress
                    $Resp = Invoke-RestMethod -Uri $Url -Method Post -ContentType "application/json; charset=utf-8" `
                        -Headers @{ "X-Ingest-Key" = $Key } -UserAgent "harness-runtime-guard/1.0" `
                        -Body ([System.Text.Encoding]::UTF8.GetBytes($Body)) -TimeoutSec 8
                    if ($Resp.decision -eq 'deny' -or $Resp.decision -eq 'ask') {
                        $DenyReason = "PDP $($Resp.decision): $($Resp.reason)"
                        Write-Warning "[harness-runtime-guard] $DenyReason"
                        if (Get-Command Write-SecurityEvent -ErrorAction SilentlyContinue) {
                            Write-SecurityEvent -HarnessRoot $HarnessRoot -Type "pdp_block" -Severity "high" `
                                -Category $ToolName -DetectedBy "harness-runtime-guard-pdp" `
                                -Excerpt "PDP $($Resp.decision): $($Resp.reason) | approval_id=$($Resp.approval_id)"
                        }
                        Write-LedgerDeny -Tool $ToolName -Pattern "pdp:$($Resp.decision)" -Command $CommandString
                        @{ permissionDecision = "deny"; reason = $DenyReason; tool = $ToolName } | ConvertTo-Json -Compress | Write-Output
                        exit 2
                    }
                }
            }
        }
    }
} catch {
    # Fail-open: a PDP/network error must never brick the developer's shell.
}

exit 0
