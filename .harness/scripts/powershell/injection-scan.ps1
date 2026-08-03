#!/usr/bin/env pwsh
<#
.SYNOPSIS
  UserPromptSubmit hook — Prompt Injection Scanner (H4).
  Scans user input for prompt injection attempts before they reach the agent.
.DESCRIPTION
  Reads stdin (user prompt text) and scans for:
    - "ignore previous instructions" / "ignore all instructions"
    - "forget everything" / "reset your instructions"
    - Encoded/base64 payloads
    - Role-play jailbreaks
    - Delimiter confusion attacks
  Returns:
    exit 0 — clean prompt
    exit 2 — injection detected (hard block)
.NOTES
  H4: This is the CORRECT place to block prompt injection — at UserPromptSubmit,
  before the prompt enters the agent's context window.
  C10: Local hook is defense-in-depth; severe injection may need server-side scanning.
#>

$InputText = $input | Out-String
if (-not $InputText) {
    exit 0
}

# Load injection patterns from config (C2)
$HarnessRoot = $env:HARNESS_ROOT
if (-not $HarnessRoot) {
    $HarnessRoot = Resolve-Path "$PSScriptRoot\..\..\.."
}

$InjectionPatternsPath = "$HarnessRoot\.harness\control\injection-patterns.json"
if (-not (Test-Path $InjectionPatternsPath)) {
    # Built-in patterns
    $Patterns = @(
        @{ pattern = '(?i)ignore\s+(all\s+)?previous\s+instructions'; severity = 'high'; category = 'instruction-override' },
        @{ pattern = '(?i)ignore\s+(all\s+)?prior\s+(instructions|directives)'; severity = 'high'; category = 'instruction-override' },
        @{ pattern = '(?i)forget\s+(everything|all\s+(previous|prior)\s+instructions)'; severity = 'high'; category = 'instruction-override' },
        @{ pattern = '(?i)reset\s+(your\s+)?(instructions|context|memory|personality)'; severity = 'high'; category = 'instruction-override' },
        @{ pattern = '(?i)you\s+(are\s+)?(now|are\s+free)\s+(to\s+)?(ignore|disregard|bypass)'; severity = 'high'; category = 'role-jailbreak' },
        @{ pattern = '(?i)DAN\s*:|do\s+anything\s+now|jail\s*break'; severity = 'high'; category = 'role-jailbreak' },
        @{ pattern = '(?i)(system|security|admin)?\s*(prompt|instruction|directive)s?\s*:\s*(ignore|override|bypass)'; severity = 'high'; category = 'system-prompt-override' },
        @{ pattern = '(?:[A-Za-z0-9+/]{40,}={0,2})'; severity = 'medium'; category = 'encoded-payload' },
        @{ pattern = '(?i)(?:hex|base64|rot13|binary)\s*(?:encode|decode|convert)\s*(?:this|the|following)'; severity = 'medium'; category = 'encoded-instruction' },
        @{ pattern = '(?i)output\s+(only|just|solely)\s+(the\s+)?(json|xml|yaml|raw)\s+(and|without)'; severity = 'medium'; category = 'output-steering' },
        @{ pattern = '(?i)print\s+(the\s+)?(full|complete|entire)\s+(prompt|system\s+prompt|instructions)'; severity = 'high'; category = 'prompt-leak' },
        @{ pattern = '(?i)repeat\s+(the\s+)?(words|text|sentence|phrase)\s+(above|before|below)'; severity = 'medium'; category = 'prompt-leak' },
        @{ pattern = '(?i)<\\s*(system|instructions?|context)\\s*>'; severity = 'medium'; category = 'delimiter-confusion' },
        @{ pattern = '(?i)---+\s*(begin|start)\s+(system|instructions?|context)'; severity = 'medium'; category = 'delimiter-confusion' }
    )
} else {
    try {
        $Patterns = Get-Content -Path $InjectionPatternsPath -Raw -Encoding utf8 | ConvertFrom-Json
        # CRIT-1: $Patterns is { $schema, description, patterns: [...] } — iterate .patterns
        $Patterns = @($Patterns.patterns)
    } catch {
        Write-Warning "[injection-scan] Cannot read injection-patterns.json, using defaults"
        $Patterns = @()
    }
}

# --- Scan ---
$Findings = @()
foreach ($entry in $Patterns) {
    if ($null -eq $entry.pattern) { continue }
    $matches = [regex]::Matches($InputText, $entry.pattern)
    foreach ($match in $matches) {
        $sig = $match.Value.Substring(0, [Math]::Min($match.Value.Length, 80))
        # Context window around the match so the excerpt is understandable
        # ("what in the prompt triggered this"), not just the bare signature.
        $start = [Math]::Max(0, $match.Index - 60)
        $len = [Math]::Min($InputText.Length - $start, $match.Length + 120)
        $ctx = $InputText.Substring($start, $len).Trim() -replace '\s+', ' '
        $ctx = $ctx.Substring(0, [Math]::Min($ctx.Length, 240))
        $Findings += [PSCustomObject]@{
            Severity = $entry.severity
            Category = $entry.category
            Match    = $sig
            Excerpt  = "matched [$($entry.category)] `"$sig`" | prompt: ...$ctx..."
        }
    }
}

# Deduplicate — ensure array for Count safety on PS 5.1
$Findings = @($Findings | Sort-Object Severity, Category -Unique)

# --- Report ---
if ($Findings.Count -eq 0) {
    exit 0
}

$HighCount = @($Findings | Where-Object { $_.Severity -eq 'high' }).Count

# Persist authoritative security events (H4) -- see lib-security-log.ps1.
$LibPath = Join-Path $PSScriptRoot "lib-security-log.ps1"
if (Test-Path $LibPath) {
    . $LibPath
    foreach ($f in $Findings) {
        Write-SecurityEvent -HarnessRoot $HarnessRoot -Type "injection" -Severity $f.Severity `
            -Category $f.Category -DetectedBy "injection-scan" -Excerpt $f.Excerpt
    }
}

Write-Warning "[injection-scan] Detected $($Findings.Count) injection signature(s) ($HighCount high)"
foreach ($f in $Findings) {
    if ($null -eq $f.Severity) { continue }
    Write-Warning "[injection-scan] [$($f.Severity.ToUpper())][$($f.Category)] $($f.Match)"
}

$Report = @{
    scanner = "injection-scan"
    total = $Findings.Count
    high = $HighCount
    findings = $Findings
} | ConvertTo-Json -Compress
Write-Output $Report

if ($HighCount -gt 0) {
    # Hard block for high severity injections
    Write-Error "[injection-scan] BLOCKED: High-severity prompt injection detected"
    exit 2
}

exit 1
