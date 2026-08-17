#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Shared helpers cho idempotency checkpoint (H2).

.DESCRIPTION
  Dot-source file nay tu idempotency-checkpoint.ps1 (PreToolUse) va
  idempotency-record.ps1 (PostToolUse) de hai ben tinh key GIONG HET nhau.

  C2: danh sach tool va rate limit doc tu .harness/control/casan-policies.yaml,
      khong hardcode o day.
  Lock store: .harness/ledger/idempotency/  (dung chung voi tool-idempotency.ps1
      cua toolkit, nhung file cua ta co suffix .hook.json de khong dam nhau).
#>

function Get-HarnessRootPath {
    param([string]$ScriptRoot)
    if ($env:HARNESS_ROOT) { return $env:HARNESS_ROOT }
    return (Resolve-Path "$ScriptRoot\..\..\..").Path
}

function Get-Sha256Hex {
    param([string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLower()
}

# Doc mot list duoi section cha trong casan-policies.yaml (C2).
# VD: Get-PolicyList -Path ... -Section 'tool' -Key 'idempotency_required'
function Get-PolicyList {
    param([string]$Path, [string]$Section, [string]$Key)
    $out = @()
    if (-not (Test-Path $Path)) { return $out }
    $inSection = $false; $inList = $false
    foreach ($line in (Get-Content -Path $Path -Encoding utf8)) {
        if ($line -match "^${Section}:") { $inSection = $true; continue }
        if ($inSection -and $line -match '^[a-z_]+:') { break }
        if ($inSection -and $line -match "^\s+${Key}:") { $inList = $true; continue }
        if ($inList) {
            if ($line -match '^\s+-\s+"?([^"#]+?)"?\s*(#.*)?$') { $out += $matches[1].Trim() }
            elseif ($line -match '^\s+[a-z_]+:') { $inList = $false }
        }
    }
    return $out
}

# Doc scalar duoi section, vd tool.idempotency_ttl_seconds
function Get-PolicyScalar {
    param([string]$Path, [string]$Section, [string]$Key, $Default)
    if (-not (Test-Path $Path)) { return $Default }
    $inSection = $false
    foreach ($line in (Get-Content -Path $Path -Encoding utf8)) {
        if ($line -match "^${Section}:") { $inSection = $true; continue }
        if ($inSection -and $line -match '^[a-z_]+:') { break }
        if ($inSection -and $line -match "^\s+${Key}:\s*([0-9]+)") { return [int]$matches[1] }
    }
    return $Default
}

# Tool nay co nam trong danh sach can idempotency khong?
# Khop ca ten tran (deploy) lan ten MCP (mcp__server__deploy).
function Resolve-IdempotentTool {
    param([string]$ToolName, [string[]]$Required)
    foreach ($r in $Required) {
        if ($ToolName -eq $r -or $ToolName -like "*__$r" -or $ToolName -like "*.$r") { return $r }
    }
    return $null
}

# mysql_query chi tinh la side-effect khi la WRITE (policy ghi ro "# writes").
function Test-IsWriteCall {
    param([string]$Base, $ToolInput)
    if ($Base -ne 'mysql_query') { return $true }
    $sql = "$($ToolInput.query)$($ToolInput.sql)"
    if (-not $sql) { return $true }
    return ($sql -match '(?is)\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b')
}

# Key = sha256(tool + input da chuan hoa). Hai hook phai goi ham nay, khong tu tinh.
function Get-IdempotencyKey {
    param([string]$ToolName, $ToolInput)
    $canon = if ($ToolInput) { $ToolInput | ConvertTo-Json -Compress -Depth 8 } else { "{}" }
    return (Get-Sha256Hex "$ToolName|$canon")
}

function Get-LockStoreDir {
    param([string]$HarnessRoot)
    $dir = Join-Path $HarnessRoot ".harness\ledger\idempotency"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}
