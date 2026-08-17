#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Approval Checkpoint (H5) — PreToolUse hook.

.DESCRIPTION
  Buộc con người xác nhận trước các action rủi ro cao, và ghi mọi lần hỏi vào
  hash-chain ledger để trả lời được câu audit "ai làm gì, lúc mấy giờ, ai duyệt".

  C2: danh sách action lấy từ .harness/control/casan-policies.yaml
      (governance.approval_required) — KHÔNG hardcode trong script này.
  C10 (honest enforcement): đây là enforcement LOCAL. Nó chặn được agent chạy
      trong Claude Code ở repo này; nó KHÔNG thay thế gateway PDP server-side.
      Bổ sung cho `enforced_at: gateway`, không phải thay thế.

  Output: JSON permissionDecision="ask" trên stdout → Claude Code hiện prompt
  xác nhận cho người dùng. exit 0 = không cần approval.

.NOTES
  Best-effort: mọi lỗi nội bộ đều exit 0 (fail-open) — một hook hỏng không được
  làm treo phiên làm việc. Deny cứng đã do harness-runtime-guard.ps1 lo.
#>

$InputJson = $input | Out-String
$InputJson = $InputJson.Trim()
if (-not $InputJson) { exit 0 }

try { $CallRecord = $InputJson | ConvertFrom-Json } catch { exit 0 }

$ToolName = if ($CallRecord.tool_name) { $CallRecord.tool_name } else { $CallRecord.tool }
$ToolInput = if ($CallRecord.tool_input) { $CallRecord.tool_input } else { $CallRecord.input }
if (-not $ToolName) { exit 0 }

$HarnessRoot = $env:HARNESS_ROOT
if (-not $HarnessRoot) { $HarnessRoot = Resolve-Path "$PSScriptRoot\..\..\.." }

$PolicyPath = "$HarnessRoot\.harness\control\casan-policies.yaml"
if (-not (Test-Path $PolicyPath)) { exit 0 }

# --- Đọc governance.approval_required (C2) -------------------------------
$Required = @()
try {
    $inGovernance = $false
    $inList = $false
    foreach ($line in (Get-Content -Path $PolicyPath -Encoding utf8)) {
        if ($line -match '^governance:') { $inGovernance = $true; continue }
        if ($inGovernance -and $line -match '^[a-z_]+:') { break }   # sang section khác
        if ($inGovernance -and $line -match '^\s+approval_required:') { $inList = $true; continue }
        if ($inList) {
            if ($line -match '^\s+-\s+"?([^"#]+?)"?\s*(#.*)?$') { $Required += $matches[1].Trim() }
            elseif ($line -match '^\s+[a-z_]+:') { $inList = $false }
        }
    }
} catch { exit 0 }
if ($Required.Count -eq 0) { exit 0 }

# --- Action này có nằm trong danh sách cần duyệt không? -------------------
# Khớp cả tool MCP (mcp__<server>__deploy) lẫn tên trần (deploy).
$Matched = $null
foreach ($r in $Required) {
    if ($ToolName -eq $r -or $ToolName -like "*__$r" -or $ToolName -like "*__${r}_*") {
        $Matched = $r; break
    }
}

# mysql_query: chỉ cần duyệt khi là WRITE (policy ghi rõ "# writes").
if ($Matched -eq 'mysql_query') {
    $sql = "$($ToolInput.query)$($ToolInput.sql)"
    if ($sql -and $sql -notmatch '(?is)\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b') {
        exit 0   # read-only → không chặn
    }
}

if (-not $Matched) { exit 0 }

# --- Ghi vào ledger: đã HỎI (chưa phải đã duyệt) -------------------------
try {
    $LedgerScript = Join-Path $PSScriptRoot "evidence-ledger.ps1"
    if (Test-Path $LedgerScript) {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $tin = if ($ToolInput) { $ToolInput | ConvertTo-Json -Compress -Depth 6 } else { "{}" }
        $inputHash = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($tin))) -replace '-', '').ToLower()
        $entry = @{
            actor = @{
                agent      = "$env:HARNESS_AGENT_NAME"
                user       = "$env:HARNESS_USER"
                session_id = "$env:HARNESS_SESSION_ID"
                role       = "member"
            }
            action = @{
                type        = "approval"
                tool        = "$ToolName"
                description = "approval requested for high-risk action '$Matched'"
                input_hash  = $inputHash
            }
            decision = @{
                result     = "ask"
                reason     = "governance.approval_required contains '$Matched'"
                risk_level = "high"
            }
        } | ConvertTo-Json -Compress -Depth 4
        & $LedgerScript append -EntryJson $entry *>$null
    }
} catch {
    # Ledger là best-effort — không được làm hỏng checkpoint.
}

# --- Yêu cầu người xác nhận ---------------------------------------------
@{
    hookSpecificOutput = @{
        hookEventName            = "PreToolUse"
        permissionDecision       = "ask"
        permissionDecisionReason = "H5 approval checkpoint: '$Matched' nam trong governance.approval_required. Da ghi vao ledger. Xac nhan de tiep tuc."
    }
} | ConvertTo-Json -Compress -Depth 4

exit 0
