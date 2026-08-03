#!/usr/bin/env pwsh
<#
.SYNOPSIS
  H1 Context Harness -- build/refresh the pipeline-context pointer store.
.DESCRIPTION
  Turns the declarative casan-policies `context` section into a real, maintained
  artifact: .harness/context/pipeline-context.yaml -- a pointer store so a
  sub-agent can DISCOVER the SRS/spec paths, tech stack and artifact locations
  from ONE file instead of re-scanning the repo (the H1 "câu hỏi chốt").

  Refreshes only when missing or older than staleness_ttl_minutes (C2: reads the
  policy; never hardcodes). Called from harness-session-start (SessionStart hook)
  so every session begins with fresh context. Ships in the bundle.
.NOTES
  Defense-in-depth / dev-ergonomics; safe to run any time.
#>
param([string]$HarnessRoot = "")

if (-not $HarnessRoot) {
    $HarnessRoot = $env:HARNESS_ROOT
    if (-not $HarnessRoot) { $HarnessRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path }
}

$Policy = "$HarnessRoot\.harness\control\casan-policies.yaml"
# Defaults mirror casan-policies.yaml `context`.
$Store = "$HarnessRoot\.harness\context\pipeline-context.yaml"
$TtlMin = 240
$RequiredKeys = @("srs_path", "spec_path", "tech_stack", "artifact_paths")

# Read policy (tiny hand parse -- avoid a YAML dep in the hook path).
if (Test-Path $Policy) {
    try {
        $raw = Get-Content -Path $Policy -Raw -Encoding utf8
        if ($raw -match 'pointer_store:\s*"?([^"\r\n]+)"?') { $Store = "$HarnessRoot\" + ($matches[1].Trim() -replace '/', '\') }
        if ($raw -match 'staleness_ttl_minutes:\s*(\d+)') { $TtlMin = [int]$matches[1] }
    } catch { }
}

# Staleness check -- skip rebuild if fresh.
if (Test-Path $Store) {
    $ageMin = ((Get-Date) - (Get-Item $Store).LastWriteTime).TotalMinutes
    if ($ageMin -lt $TtlMin) {
        Write-Output "[context] pipeline-context.yaml fresh ($([math]::Round($ageMin))m < ${TtlMin}m) -- kept"
        exit 0
    }
}

$HarnessRoot = $HarnessRoot.TrimEnd('\', '/')

# Read a YAML string-list under `<key>:` from the policy (C2 - discovery lives in
# config). Naive on purpose: the hook path must not need a YAML dependency. The
# key line may carry a trailing comment.
function Get-YamlList([string]$key) {
    if (-not (Test-Path $Policy)) { return @() }
    $out = @(); $inBlock = $false
    foreach ($line in Get-Content $Policy -Encoding utf8) {
        if ($line -match ("^\s*" + [regex]::Escape($key) + ":\s*(#.*)?$")) { $inBlock = $true; continue }
        if ($inBlock) {
            if ($line -match '^\s*#') { continue }
            if ($line -match '^\s*-\s*(.+?)\s*$') {
                $v = $matches[1] -replace '\s+#.*$', ''
                $v = $v.Trim().Trim('"').Trim("'")
                if ($v) { $out += $v }
            } elseif ($line -match '\S') { break }
        }
    }
    return $out
}

function Sort-Ordinal([string[]]$items) {
    $a = @($items)
    if ($a.Count -gt 1) { [Array]::Sort($a, [System.StringComparer]::Ordinal) }
    return $a
}

# Deterministic pointer discovery: an entry with no wildcard is an exact path
# taken when present (canonical wins); a wildcard entry globs recursively and the
# matches are SORTED (ordinal, so it is stable across machines/locales).
function Find-First([string[]]$candidates) {
    foreach ($c in $candidates) {
        if ($c -match '[*?]') {
            $rel = Get-ChildItem -Path $HarnessRoot -Recurse -File -Filter $c -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|dist|build|\.harness)\\' } |
                ForEach-Object { $_.FullName.Substring($HarnessRoot.Length + 1) -replace '\\', '/' }
            $rel = Sort-Ordinal $rel
            if ($rel.Count -gt 0) { return $rel[0] }
        } elseif (Test-Path (Join-Path $HarnessRoot $c)) {
            return ($c -replace '\\', '/')
        }
    }
    return ""
}

# --- Discover pointers (best-effort; empty string when absent) ---
$srsCand = Get-YamlList "srs_candidates"
if (-not $srsCand) { $srsCand = @("SRS*.md", "srs*.md", "*requirements*.md") }
$specCand = Get-YamlList "spec_candidates"
if (-not $specCand) { $specCand = @("*spec*.md", "SPEC*.md", "openapi*.y*ml") }
$srs = Find-First $srsCand
$spec = Find-First $specCand

# Tech stack detection from manifest files present at root/near-root.
$stack = @()
if (Test-Path "$HarnessRoot\package.json") { $stack += "node" }
if (Test-Path "$HarnessRoot\requirements.txt") { $stack += "python" }
if (Test-Path "$HarnessRoot\pyproject.toml") { $stack += "python" }
if (Test-Path "$HarnessRoot\go.mod") { $stack += "go" }
if (Test-Path "$HarnessRoot\pom.xml") { $stack += "java" }
if (Test-Path "$HarnessRoot\Cargo.toml") { $stack += "rust" }
if (Test-Path "$HarnessRoot\composer.json") { $stack += "php" }
if (-not $stack) { $stack = @("unknown") }
$stack = $stack | Select-Object -Unique

# Artifact dirs, resolved from config (C2). A glob match that is a directory
# contributes itself; a match that is a FILE contributes its parent dir -- that
# is what makes "*/__init__.py" name the Python package on layouts whose source
# dir is not called "src".
function Resolve-Dirs([string]$glob) {
    $out = @()
    $full = Join-Path $HarnessRoot $glob
    if ($glob -notmatch '[*?]') {
        # Exact path: take the directory ITSELF. Get-ChildItem on a directory
        # lists its children instead, and returns nothing for an empty dir.
        $it = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
        if ($it) {
            $p = if ($it.PSIsContainer) { $it.FullName } else { $it.DirectoryName }
            if ($p -and $p.Length -gt $HarnessRoot.Length) {
                $out += ($p.Substring($HarnessRoot.Length + 1) -replace '\\', '/')
            }
        }
    } else {
        foreach ($it in (Get-ChildItem -Path $full -Force -ErrorAction SilentlyContinue)) {
            $p = if ($it.PSIsContainer) { $it.FullName } else { $it.DirectoryName }
            if (-not $p -or $p.Length -le $HarnessRoot.Length) { continue }
            $out += ($p.Substring($HarnessRoot.Length + 1) -replace '\\', '/')
        }
    }
    return (Sort-Ordinal ($out | Select-Object -Unique))
}
$artGlobs = Get-YamlList "artifact_globs"
if (-not $artGlobs) { $artGlobs = @("docs", "tests", "contracts", ".harness") }
$srcGlobs = Get-YamlList "source_globs"
if (-not $srcGlobs) { $srcGlobs = @("src", "app", "lib", "*/__init__.py") }
$artifacts = @()
foreach ($g in @($srcGlobs) + @($artGlobs)) {
    foreach ($hit in (Resolve-Dirs $g)) {
        if ($artifacts -notcontains $hit) { $artifacts += $hit }
    }
}

# --- Write the pointer store (ASCII YAML -- avoid PS 5.1 mojibake) ---
$dir = Split-Path -Parent $Store
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$lines = @()
$lines += "# pipeline-context pointer store (H1) -- auto-built by harness-context-build."
$lines += "# Sub-agents read this to discover inputs WITHOUT re-scanning the repo."
$lines += "generated_at: `"$now`""
$lines += "srs_path: `"$srs`""
$lines += "spec_path: `"$spec`""
$lines += "tech_stack: [$(( $stack | ForEach-Object { '`"' + $_ + '`"' }) -join ', ')]"
$lines += "artifact_paths: [$(( $artifacts | ForEach-Object { '`"' + $_ + '`"' }) -join ', ')]"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Store, ($lines -join "`n") + "`n", $Utf8NoBom)

$missing = @()
if (-not $srs) { $missing += "srs_path" }
if (-not $spec) { $missing += "spec_path" }
Write-Output "[context] built pipeline-context.yaml (stack=$($stack -join '/'); artifacts=$($artifacts.Count))$(if ($missing) { ' missing: ' + ($missing -join ',') })"

# H1 RAG-lite -- (re)build the retrieval index over context sources (best-effort).
$Rag = "$HarnessRoot\.harness\scripts\lib\harness_rag.py"
if (Test-Path $Rag) {
    $py = (Get-Command python3 -ErrorAction SilentlyContinue); if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
    if ($py) { $env:HARNESS_ROOT = $HarnessRoot; try { & $py.Source $Rag index --root $HarnessRoot } catch { } }
}
exit 0
