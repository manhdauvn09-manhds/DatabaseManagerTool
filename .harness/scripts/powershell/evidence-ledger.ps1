#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Hash-chain ledger + Evidence Bundle generator (H5).
  Append-only immutable audit trail for all harness actions.
.DESCRIPTION
  Maintains an append-only hash-chain ledger at .harness/ledger/chain.jsonl
  Each entry contains prev_hash linking to the previous entry -- tampering with
  any entry breaks the chain for all subsequent entries.

  Also generates Evidence Bundles per change (8-part DoD per §18.3 spec).

  Commands:
    init      - Create genesis block
    append    - Add a new ledger entry (-EntryJson, -EntryFile, or piped stdin)
    verify    - Verify chain integrity from genesis to head
    bundle    - Generate an evidence bundle for a change (-EntryJson/-EntryFile/stdin)
    export    - Export ledger as CSV

  Input resolution order for append/bundle (PIPE-1 fix): -EntryJson string,
  then -EntryFile path (recommended for callers -- avoids command-line
  quoting/length limits), then piped stdin. If none of these are actually
  available, the script fails fast with an error instead of blocking on a
  console read that will never resolve.
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("init", "append", "verify", "bundle", "export")]
    [string]$Command = "append",

    [string]$LedgerDir = "",

    [string]$EntryJson = "",

    [string]$EntryFile = ""
)

# --- Helper: resolve entry input without ever blocking on an unredirected console (PIPE-1) ---
function Get-EntryInput {
    param(
        [string]$EntryJsonParam,
        [string]$EntryFileParam
    )
    if ($EntryJsonParam) { return $EntryJsonParam }
    if ($EntryFileParam) {
        if (-not (Test-Path $EntryFileParam)) {
            Write-Error "[evidence-ledger] -EntryFile not found: $EntryFileParam"
            exit 1
        }
        return Get-Content -Path $EntryFileParam -Raw -Encoding utf8
    }
    if ([Console]::IsInputRedirected) {
        return [Console]::In.ReadToEnd()
    }
    Write-Error "[evidence-ledger] No input provided -- pass -EntryJson, -EntryFile, or pipe JSON via stdin"
    exit 1
}

# Resolve paths
$HarnessRoot = $env:HARNESS_ROOT
if (-not $HarnessRoot) { $HarnessRoot = Resolve-Path "$PSScriptRoot\..\..\.." }
if (-not $LedgerDir) { $LedgerDir = "$HarnessRoot\.harness\ledger" }
if (-not (Test-Path $LedgerDir)) { New-Item -ItemType Directory -Path $LedgerDir -Force | Out-Null }

$ChainFile = "$LedgerDir\chain.jsonl"
$BundleDir = "$LedgerDir\bundles"
if (-not (Test-Path $BundleDir)) { New-Item -ItemType Directory -Path $BundleDir -Force | Out-Null }

# --- Helper: write/append UTF-8 without BOM (Windows PowerShell 5.1's `-Encoding
#     utf8` always emits a BOM, contaminating an otherwise-clean append-only
#     JSONL ledger -- same class of defect as H-INIT-3) ---
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8NoBom {
    param([string]$Path, [string]$Value)
    [System.IO.File]::WriteAllText($Path, $Value, $Utf8NoBom)
}

function Add-Utf8NoBom {
    param([string]$Path, [string]$Value)
    [System.IO.File]::AppendAllText($Path, $Value, $Utf8NoBom)
}

# --- Helper: SHA-256 hash ---
function Get-EntryHash {
    param([string]$Json)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
    $hash = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new($bytes)) -Algorithm SHA256).Hash.ToLower()
    return $hash
}

# --- Helper: read last entry ---
function Get-LastEntry {
    if (Test-Path $ChainFile) {
        $lastLine = Get-Content -Path $ChainFile -Tail 1 -Encoding utf8 -ErrorAction SilentlyContinue
        if ($lastLine) {
            try { return $lastLine | ConvertFrom-Json } catch { return $null }
        }
    }
    return $null
}

# --- Helper: get chain length ---
function Get-ChainLength {
    if (Test-Path $ChainFile) {
        $lines = Get-Content -Path $ChainFile -Encoding utf8 -ErrorAction SilentlyContinue
        return ($lines | Where-Object { $_ -ne '' }).Count
    }
    return 0
}

# ===== COMMANDS =====

switch ($Command) {
    "init" {
        # Create genesis block
        $Genesis = @{
            index = 0
            prev_hash = "GENESIS"
            entry_hash = ""
            timestamp = (Get-Date -Format 'o')
            actor = @{
                agent = "harness"
                user = "system"
                session_id = "genesis"
                role = "system"
            }
            action = @{
                type = "config_change"
                tool = "harness-init"
                description = "Genesis block -- harness ledger initialized"
            }
            decision = @{
                result = "allow"
                reason = "System initialization"
                risk_level = "none"
            }
            payload_ref = ""
            signature = ""
        }
        $JsonWithoutHash = $Genesis | ConvertTo-Json -Depth 10 -Compress
        $Genesis.entry_hash = Get-EntryHash $JsonWithoutHash

        $GenesisJson = $Genesis | ConvertTo-Json -Depth 10 -Compress
        Write-Utf8NoBom -Path $ChainFile -Value "$GenesisJson`n"

        Write-Output "[evidence-ledger] Genesis block created at index 0"
        Write-Output "[evidence-ledger] Hash: $($Genesis.entry_hash)"
        Write-Output "[evidence-ledger] Chain file: $ChainFile"
        break
    }

    "append" {
        $InputJson = Get-EntryInput -EntryJsonParam $EntryJson -EntryFileParam $EntryFile
        if (-not $InputJson -or $InputJson.Trim() -eq "") {
            Write-Error "[evidence-ledger] No input provided for append"
            exit 1
        }

        try {
            $Entry = $InputJson | ConvertFrom-Json
        } catch {
            Write-Error "[evidence-ledger] Invalid input JSON: $_"
            exit 1
        }

        $LastEntry = Get-LastEntry
        $NextIndex = if ($LastEntry) { $LastEntry.index + 1 } else { 0 }
        $PrevHash = if ($LastEntry) { $LastEntry.entry_hash } else { "GENESIS" }

        # Build canonical entry
        $NewEntry = @{
            index = $NextIndex
            prev_hash = $PrevHash
            entry_hash = ""  # Will compute after serialization
            timestamp = (Get-Date -Format 'o')
            actor = @{
                agent = if ($Entry.actor.agent) { $Entry.actor.agent } else { "unknown" }
                user = if ($Entry.actor.user) { $Entry.actor.user } else { "unknown" }
                session_id = if ($Entry.actor.session_id) { $Entry.actor.session_id } else { $env:HARNESS_SESSION_ID }
                role = if ($Entry.actor.role) { $Entry.actor.role } else { "" }
            }
            action = @{
                type = if ($Entry.action.type) { $Entry.action.type } else { "tool_call" }
                tool = if ($Entry.action.tool) { $Entry.action.tool } else { "" }
                description = if ($Entry.action.description) { $Entry.action.description } else { "" }
                input_hash = if ($Entry.action.input_hash) { $Entry.action.input_hash } else { "" }
                output_hash = if ($Entry.action.output_hash) { $Entry.action.output_hash } else { "" }
            }
            decision = @{
                result = if ($Entry.decision.result) { $Entry.decision.result } else { "allow" }
                reason = if ($Entry.decision.reason) { $Entry.decision.reason } else { "" }
                risk_level = if ($Entry.decision.risk_level) { $Entry.decision.risk_level } else { "none" }
            }
            payload_ref = if ($Entry.payload_ref) { $Entry.payload_ref } else { "" }
            signature = if ($Entry.signature) { $Entry.signature } else { "" }
        }

        $JsonWithoutHash = $NewEntry | ConvertTo-Json -Depth 10 -Compress
        $NewEntry.entry_hash = Get-EntryHash $JsonWithoutHash

        $OutEntryJson = $NewEntry | ConvertTo-Json -Depth 10 -Compress
        Add-Utf8NoBom -Path $ChainFile -Value "$OutEntryJson`n"

        Write-Output "[evidence-ledger] Appended entry $NextIndex"
        Write-Output "[evidence-ledger] Hash: $($NewEntry.entry_hash) | Prev: $PrevHash"
        Write-Output $OutEntryJson
        break
    }

    "verify" {
        if (-not (Test-Path $ChainFile)) {
            Write-Error "[evidence-ledger] No chain file found at $ChainFile"
            exit 1
        }

        $Lines = Get-Content -Path $ChainFile -Encoding utf8 -ErrorAction SilentlyContinue | Where-Object { $_ -ne '' }
        $TotalEntries = $Lines.Count
        $Valid = $true
        $PreviousHash = "GENESIS"

        for ($i = 0; $i -lt $TotalEntries; $i++) {
            $Entry = $Lines[$i] | ConvertFrom-Json

            # Verify prev_hash chain
            if ($Entry.prev_hash -ne $PreviousHash) {
                Write-Error "[evidence-ledger] CHAIN BREAK at entry $($Entry.index): prev_hash mismatch"
                Write-Error "[evidence-ledger]   Expected: $PreviousHash"
                Write-Error "[evidence-ledger]   Got:      $($Entry.prev_hash)"
                $Valid = $false
            }

            # Verify entry_hash
            $StoredHash = $Entry.entry_hash
            $Entry.entry_hash = ""
            $JsonWithoutHash = $Entry | ConvertTo-Json -Depth 10 -Compress
            $ComputedHash = Get-EntryHash $JsonWithoutHash

            if ($ComputedHash -ne $StoredHash) {
                Write-Error "[evidence-ledger] TAMPER DETECTED at entry $($Entry.index): entry_hash mismatch"
                Write-Error "[evidence-ledger]   Computed: $ComputedHash"
                Write-Error "[evidence-ledger]   Stored:   $StoredHash"
                $Valid = $false
            }

            $PreviousHash = $StoredHash
        }

        if ($Valid) {
            Write-Output "[evidence-ledger] LEDGER INTACT -- $TotalEntries entries, all hashes verified"
        } else {
            Write-Error "[evidence-ledger] LEDGER COMPROMISED -- integrity check FAILED"
            exit 2
        }
        break
    }

    "bundle" {
        # Generate an evidence bundle for a change
        $InputJson = Get-EntryInput -EntryJsonParam $EntryJson -EntryFileParam $EntryFile
        if (-not $InputJson -or $InputJson.Trim() -eq "") {
            Write-Error "[evidence-ledger] No input provided for bundle"
            exit 1
        }

        $Input = $InputJson | ConvertFrom-Json
        $BundleId = [guid]::NewGuid().ToString()
        $ChangeId = if ($Input.change_id) { $Input.change_id } else { "change-$(Get-Date -Format 'yyyyMMddHHmmss')" }

        $Bundle = @{
            bundle_id = $BundleId
            change_id = $ChangeId
            created_at = (Get-Date -Format 'o')
            created_by = @{
                agent = if ($Input.created_by.agent) { $Input.created_by.agent } else { "unknown" }
                user = if ($Input.created_by.user) { $Input.created_by.user } else { "unknown" }
                session_id = if ($Input.created_by.session_id) { $Input.created_by.session_id } else { $env:HARNESS_SESSION_ID }
            }
            requirement_trace = @{
                spec_ref = if ($Input.requirement_trace.spec_ref) { $Input.requirement_trace.spec_ref } else { "" }
                requirement_ids = if ($Input.requirement_trace.requirement_ids) { $Input.requirement_trace.requirement_ids } else { @() }
            }
            design_impact = @{
                description = if ($Input.design_impact.description) { $Input.design_impact.description } else { "" }
                affected_components = if ($Input.design_impact.affected_components) { $Input.design_impact.affected_components } else { @() }
                design_doc_ref = if ($Input.design_impact.design_doc_ref) { $Input.design_impact.design_doc_ref } else { "" }
            }
            code_diff = @{
                files_changed = if ($Input.code_diff.files_changed) { $Input.code_diff.files_changed } else { @() }
                diff_ref = if ($Input.code_diff.diff_ref) { $Input.code_diff.diff_ref } else { "" }
                diff_hash = if ($Input.code_diff.diff_hash) { $Input.code_diff.diff_hash } else { "" }
            }
            test_report = @{
                passed = if ($Input.test_report.passed) { $Input.test_report.passed } else { 0 }
                failed = if ($Input.test_report.failed) { $Input.test_report.failed } else { 0 }
                skipped = if ($Input.test_report.skipped) { $Input.test_report.skipped } else { 0 }
                coverage_percent = if ($Input.test_report.coverage_percent) { $Input.test_report.coverage_percent } else { 0 }
                report_ref = if ($Input.test_report.report_ref) { $Input.test_report.report_ref } else { "" }
            }
            security_scan = @{
                scanner = if ($Input.security_scan.scanner) { $Input.security_scan.scanner } else { "" }
                findings_count = if ($Input.security_scan.findings_count) { $Input.security_scan.findings_count } else { 0 }
                high_critical_count = if ($Input.security_scan.high_critical_count) { $Input.security_scan.high_critical_count } else { 0 }
                passed = if ($Input.security_scan.passed) { $Input.security_scan.passed } else { $true }
                report_ref = if ($Input.security_scan.report_ref) { $Input.security_scan.report_ref } else { "" }
            }
            review_verdict = @{
                verdict = if ($Input.review_verdict.verdict) { $Input.review_verdict.verdict } else { "PENDING" }
                score = if ($Input.review_verdict.score) { $Input.review_verdict.score } else { 0 }
                reviewer_agent = if ($Input.review_verdict.reviewer_agent) { $Input.review_verdict.reviewer_agent } else { "" }
                feedback = if ($Input.review_verdict.feedback) { $Input.review_verdict.feedback } else { "" }
            }
            approval_record = @{
                required = if ($Input.approval_record.required) { $Input.approval_record.required } else { $false }
                approved_by = if ($Input.approval_record.approved_by) { $Input.approval_record.approved_by } else { "" }
                approved_at = if ($Input.approval_record.approved_at) { $Input.approval_record.approved_at } else { "" }
                approval_ref = if ($Input.approval_record.approval_ref) { $Input.approval_record.approval_ref } else { "" }
            }
            cost_telemetry = @{
                tokens_used = if ($Input.cost_telemetry.tokens_used) { $Input.cost_telemetry.tokens_used } else { 0 }
                estimated_cost_usd = if ($Input.cost_telemetry.estimated_cost_usd) { $Input.cost_telemetry.estimated_cost_usd } else { 0 }
                duration_seconds = if ($Input.cost_telemetry.duration_seconds) { $Input.cost_telemetry.duration_seconds } else { 0 }
            }
        }

        $BundleJson = $Bundle | ConvertTo-Json -Depth 10
        $BundleFile = "$BundleDir\$ChangeId-bundle.json"
        Write-Utf8NoBom -Path $BundleFile -Value $BundleJson

        Write-Output "[evidence-ledger] Evidence bundle created: $BundleFile"
        Write-Output "[evidence-ledger] Bundle ID: $BundleId"
        Write-Output "[evidence-ledger] Change ID: $ChangeId"
        Write-Output $BundleJson
        break
    }

    "export" {
        if (-not (Test-Path $ChainFile)) {
            Write-Error "[evidence-ledger] No chain file found"
            exit 1
        }
        $Lines = Get-Content -Path $ChainFile -Encoding utf8 | Where-Object { $_ -ne '' }
        $CsvFile = "$LedgerDir\ledger-export-$(Get-Date -Format 'yyyyMMddHHmmss').csv"
        Write-Utf8NoBom -Path $CsvFile -Value "index,timestamp,agent,action_type,tool,decision_result,risk_level,entry_hash,prev_hash`n"
        foreach ($line in $Lines) {
            $e = $line | ConvertFrom-Json
            Add-Utf8NoBom -Path $CsvFile -Value "$($e.index),$($e.timestamp),$($e.actor.agent),$($e.action.type),$($e.action.tool),$($e.decision.result),$($e.decision.risk_level),$($e.entry_hash),$($e.prev_hash)`n"
        }
        Write-Output "[evidence-ledger] Exported $($Lines.Count) entries to $CsvFile"
        break
    }
}
