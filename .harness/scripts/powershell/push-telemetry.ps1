#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Push local .harness telemetry to the Control Portal (push-ingest API).
.DESCRIPTION
  For dev machines whose checkout path the Portal backend cannot read (e.g.
  Windows E:\ checkouts). Reads the local telemetry/ledger files and POSTs
  their contents to POST {portal_url}/api/ingest/{project_id}. The backend
  runs the same ingest pipeline it uses for server checkouts (same dedupe),
  so re-pushing the same files is safe and idempotent.

  Config: .harness/portal-sync.json
    { "portal_url": "https://<portal-host>", "project_id": "<uuid>" }
  Ingest key (C5 — never commit it): either env HARNESS_PORTAL_INGEST_KEY or
  the git-ignored file .harness/portal-sync.key (single line).

  Wired into harness-session-end.ps1 (best-effort) so every session pushes
  automatically; safe to run by hand any time.
#>
param(
    [string]$HarnessRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $HarnessRoot) {
    $HarnessRoot = $env:HARNESS_ROOT
    if (-not $HarnessRoot) { $HarnessRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path }
}

$ConfigFile = Join-Path $HarnessRoot ".harness\portal-sync.json"
if (-not (Test-Path $ConfigFile)) {
    Write-Output "[push-telemetry] No .harness/portal-sync.json -- push sync not configured, skipping."
    exit 0
}
$Config = Get-Content -Path $ConfigFile -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $Config.portal_url -or -not $Config.project_id) {
    Write-Warning "[push-telemetry] portal-sync.json missing portal_url/project_id"
    exit 0
}

# Ingest key: env wins, then git-ignored key file (C5: never in the repo).
$IngestKey = $env:HARNESS_PORTAL_INGEST_KEY
if (-not $IngestKey) {
    $KeyFile = Join-Path $HarnessRoot ".harness\portal-sync.key"
    if (Test-Path $KeyFile) { $IngestKey = (Get-Content -Path $KeyFile -Raw).Trim() }
}
if (-not $IngestKey) {
    Write-Warning "[push-telemetry] No ingest key (env HARNESS_PORTAL_INGEST_KEY or .harness/portal-sync.key)"
    exit 0
}

function Read-IfExists([string]$Path) {
    if (Test-Path $Path) {
        # utf8 read strips BOM; returns "" for empty files
        return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    }
    return ""
}

# --- Self-healing resample: rebuild agentops.log from THIS project's Claude
# Code transcripts before pushing, so token usage is captured even if the
# SessionEnd sampler never fired. Transcript dirs are matched CASE-INSENSITIVELY
# (Claude Code encodes the drive letter as 'E--' or 'e--') and recursively
# (sub-folders, git worktrees, and subagents/*.jsonl). Best-effort; a failure
# here never blocks the push of whatever agentops.log already exists.
#
# Read-merge-write, NOT blind overwrite: agentops-sampler.ps1 (SubagentStop
# hook) already stamps active_account/active_member onto rows it writes live.
# This block only sees raw transcripts, which carry neither field, so a plain
# "w" rebuild from scratch would erase every stamp on every push -- and for a
# plain (non-delegating) main session, this resample is the ONLY writer, since
# the sampler is wired solely to SubagentStop. Fix: read whatever agentops.log
# already has, keyed the same way (session_id:agent_name); a transcript-derived
# row only replaces an existing one when it has STRICTLY MORE tokens (genuine
# "resumed, more happened" case), and only a replaced/new row gets re-stamped
# with the CURRENT pointer/env values -- coarser than a live per-turn stamp,
# but far better than silently blank. Anything the transcript scan doesn't
# touch at all (rotated out of the transcript window) survives untouched.
try {
    $rs = @'
import os, re, json, glob
from datetime import datetime, timezone
root = os.environ["HS_ROOT"]
home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
proot = os.path.join(home, ".claude", "projects")

def _load_existing(fp):
    # Keyed identically to the transcript scan below so the merge lines up.
    # Unparseable lines are skipped, never allowed to crash the resample.
    d = {}
    try:
        with open(fp, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try: rec = json.loads(line)
                except Exception: continue
                sid = rec.get("session_id"); agent = rec.get("agent_name")
                if not sid or not agent: continue
                d[sid + ":" + agent] = rec
    except OSError:
        pass
    return d

def _active_account():
    # Same global per-machine pointer harness-switch-account writes; absent or
    # unreadable -> "" so an old client (no such file yet) sees the same blank
    # it always has.
    try:
        p = os.path.join(home, ".harness", "active-account.local.json")
        with open(p, encoding="utf-8-sig") as f:
            return str((json.load(f) or {}).get("active_account") or "")
    except Exception:
        return ""

if os.path.isdir(proot):
    e = re.sub(r"[:\\/._]", "-", root).lower()
    dirs = [d for d in glob.glob(os.path.join(proot, "*")) if os.path.isdir(d)
            and (os.path.basename(d).lower() == e or os.path.basename(d).lower().startswith(e + "-"))]
    def sample(fp):
        tin = tout = tools = 0; model = ""; first = last = None; by = {}
        try:
            with open(fp, encoding="utf-8-sig") as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    try: rec = json.loads(line)
                    except Exception: continue
                    ts = rec.get("timestamp")
                    if ts: first = first or ts; last = ts
                    if rec.get("type") != "assistant": continue
                    msg = rec.get("message") or {}
                    if not isinstance(msg, dict): continue
                    u = msg.get("usage"); mid = msg.get("id")
                    if u and mid: by[mid] = u
                    m = msg.get("model")
                    if m and m != "<synthetic>": model = m
                    for b in (msg.get("content") or []):
                        if isinstance(b, dict) and b.get("type") == "tool_use": tools += 1
        except OSError:
            return None
        for u in by.values():
            tin += int(u.get("input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0)
            tout += int(u.get("output_tokens") or 0)
        if tin == 0 and tout == 0 and not model: return None
        return {"tin": tin, "tout": tout, "tools": tools, "model": model or "unknown", "first": first, "last": last}
    entries = {}
    for d in dirs:
        for fp in glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True):
            sid = os.path.splitext(os.path.basename(fp))[0]
            r = sample(fp)
            if not r: continue
            agent = "subagent" if (os.sep + "subagents" + os.sep) in fp else "main"
            k = sid + ":" + agent
            prev = entries.get(k)
            if prev and (prev["tin"] + prev["tout"]) >= (r["tin"] + r["tout"]): continue
            r["sid"] = sid; r["agent"] = agent; entries[k] = r
    if entries:
        tel = os.path.join(root, ".harness", "telemetry"); os.makedirs(tel, exist_ok=True)
        log_path = os.path.join(tel, "agentops.log")
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        active_account = _active_account()
        active_member = os.environ.get("HARNESS_USER") or ""
        # Union base: every row the current file already has, so anything the
        # transcript scan below has no key for is preserved untouched.
        merged = _load_existing(log_path)
        for r in entries.values():
            k = r["sid"] + ":" + r["agent"]
            old_rec = merged.get(k)
            new_tokens = r["tin"] + r["tout"]
            if old_rec is not None:
                old_tokens = int(old_rec.get("tokens_in") or 0) + int(old_rec.get("tokens_out") or 0)
                if old_tokens >= new_tokens:
                    continue  # existing row (and its active_account/active_member) survives untouched
            cost = r["tin"] / 1e6 * 3.0 + r["tout"] / 1e6 * 15.0
            merged[k] = {
                "timestamp": now, "agent_name": r["agent"], "model": r["model"], "session_id": r["sid"],
                "status": "completed", "tokens_in": r["tin"], "tokens_out": r["tout"],
                "total_tokens": r["tin"] + r["tout"], "estimated_cost_usd": round(cost, 6),
                "latency_ms": 0, "tool_calls": r["tools"],
                "start_time": r["first"] or now, "end_time": r["last"] or now,
                "active_account": active_account, "active_member": active_member,
            }
        with open(log_path, "w", encoding="utf-8") as out:
            for rec in merged.values():
                out.write(json.dumps(rec, separators=(",", ":")) + "\n")
'@
    $py = (Get-Command python3 -ErrorAction SilentlyContinue) ; if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
    if ($py) { $env:HS_ROOT = $HarnessRoot; $rs | & $py.Source - }
} catch { }

$Tel = Join-Path $HarnessRoot ".harness\telemetry"
$Ledger = Join-Path $HarnessRoot ".harness\ledger"

$Body = @{
    agentops        = Read-IfExists (Join-Path $Tel "agentops.log")
    chain_jsonl     = Read-IfExists (Join-Path $Ledger "chain.jsonl")
    security_events = Read-IfExists (Join-Path $Tel "security-events.jsonl")
    tool_calls      = Read-IfExists (Join-Path $Tel "tool-calls.log")
    test_reports    = Read-IfExists (Join-Path $Tel "test-reports.jsonl")
    member_email    = "$($Config.member_email)"
    buglist         = Read-IfExists (Join-Path $HarnessRoot "buglist.md")
}

# H3 — evidence bundles -> prompt_scores (send {filename: content})
$Bundles = @{}
$BundleDir = Join-Path $Ledger "bundles"
if (Test-Path $BundleDir) {
    foreach ($bf in Get-ChildItem -Path $BundleDir -Filter *.json -File -ErrorAction SilentlyContinue) {
        # Read-IfExists, not Get-Content -Raw: the FileSystem provider hangs
        # PSPath/PSDrive/PSProvider NoteProperties off the string it returns, so
        # ConvertTo-Json emits {"value":"...","PSPath":...} instead of a bare
        # string — and bundles is typed dict[str,str], so the ingest model 422s
        # the ENTIRE push, telemetry included, not just the bundle.
        $Bundles[$bf.Name] = Read-IfExists $bf.FullName
    }
}
$Body.bundles = $Bundles

# H1 — source<->doc traceability scan (this repo). Best-effort: needs the
# bundle-installed scanner lib + a python interpreter; skipped silently if absent.
$Body.source_doc_map = ""
$DocScan = Join-Path $HarnessRoot ".harness\scripts\lib\harness_docscan.py"
$pyd = (Get-Command python3 -ErrorAction SilentlyContinue); if (-not $pyd) { $pyd = Get-Command python -ErrorAction SilentlyContinue }
if ($pyd -and (Test-Path $DocScan)) {
    try { $Body.source_doc_map = (& $pyd.Source $DocScan $HarnessRoot 2>$null | Out-String).Trim() } catch { }
}
# CASAN evidence snapshot — a push-based project has no server checkout, so
# harness_root_ref is empty and every machine-checked criterion reads not-met.
# Ship the raw files those checks read; scoring stays server-side, so this can
# only cost the project points, never inflate them. Same best-effort contract
# as source_doc_map above: needs python + the bundle-installed lib.
$Body.casan_files = @{}
$Body.casan_manifest = @()
$Body.casan_skipped = @()
$SnapLib = Join-Path $HarnessRoot ".harness\scripts\lib\harness_casan_snapshot.py"
if ($pyd -and (Test-Path $SnapLib)) {
    try {
        # -join "" rather than Out-String: the payload is one very long line and
        # Out-String is a formatter, not a concatenator.
        $SnapRaw = ((& $pyd.Source $SnapLib $HarnessRoot 2>$null) -join "")
        if ($SnapRaw) {
            $Snap = $SnapRaw | ConvertFrom-Json
            # Rehydrate as a hashtable, not the PSCustomObject ConvertFrom-Json
            # returns: PS 5.1 calls any non-null object $true, so an empty
            # PSCustomObject would silently defeat the guard below.
            $cf = @{}
            foreach ($p in $Snap.files.PSObject.Properties) { $cf[$p.Name] = $p.Value }
            $Body.casan_files = $cf
            # @(... | Where-Object { $_ }) so a single-entry list stays an array
            # AND an absent key does not become @($null) -> [null]: the ingest
            # model types these list[dict] and 422s the ENTIRE push on a null
            # element, telemetry included.
            $Body.casan_manifest = @($Snap.manifest | Where-Object { $_ })
            # The third state. Without it the server cannot tell a control we
            # deliberately did not send from one the project does not have, and
            # it scores both as not-met — a false RED is as bad as a false GREEN.
            $Body.casan_skipped = @($Snap.skipped | Where-Object { $_ })
            $Withheld = @($Body.casan_skipped | Where-Object { $_.withheld }).Count
            Write-Output ("[push-telemetry] CASAN snapshot: {0} files, {1} manifest entries, {2} skipped ({3} withheld)" -f `
                $cf.Count, $Body.casan_manifest.Count, $Body.casan_skipped.Count, $Withheld)
        }
    } catch { }
}

# A value counts as content only if it actually carries data. PS 5.1 treats any
# non-null object as $true, so `Where-Object { $_ }` passed the always-present
# (and usually empty) bundles hashtable and this guard could never fire.
$HasContent = $false
foreach ($v in $Body.Values) {
    if ($v -is [string]) { if ($v.Trim()) { $HasContent = $true; break } }
    elseif ($v -is [System.Collections.ICollection]) { if ($v.Count -gt 0) { $HasContent = $true; break } }
    elseif ($v) { $HasContent = $true; break }
}
if (-not $HasContent) {
    Write-Output "[push-telemetry] Nothing to push (no telemetry files yet)."
    exit 0
}

$Url = "$($Config.portal_url.TrimEnd('/'))/api/ingest/$($Config.project_id)"
try {
    # TLS 1.2 for PS 5.1 boxes that still default to 1.0
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    # -Depth 6 is margin, not a fix: casan_manifest and casan_skipped are both
    # arrays of flat objects, which lands at depth 3 (body -> array -> object ->
    # scalar) — past the default of 2, where ConvertTo-Json would silently
    # render an entry as the string "@{path=...; size=...}". Data-shaped enough
    # that the server would store it and nobody would notice.
    $Json = $Body | ConvertTo-Json -Depth 6 -Compress
    # Cloudflare's bot rules 403 generic client UAs; identify as the harness client.
    $Resp = Invoke-RestMethod -Uri $Url -Method Post -ContentType "application/json; charset=utf-8" `
        -Headers @{ "X-Ingest-Key" = $IngestKey } -UserAgent "harness-push-telemetry/1.0" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($Json)) -TimeoutSec 30
    Write-Output ("[push-telemetry] OK: actions={0} incidents={1} usage={2} tool_calls={3}" -f `
        $Resp.action_log_ingested, $Resp.security_incidents_ingested, $Resp.usage_events_ingested, $Resp.tool_calls_ingested)
} catch {
    # Never fail the calling hook on a network error; the next push retries
    # everything anyway (server-side dedupe makes it idempotent).
    #
    # But DO print the server's response body. .Exception.Message is only the
    # status line, so a 422 that names the offending field read as an empty,
    # undiagnosable error — a consuming project lost days to exactly that.
    # On Windows PowerShell 5.1 the body is in $_.ErrorDetails.Message:
    # Invoke-RestMethod has ALREADY drained the response stream by the time it
    # throws, so GetResponseStream() hands back an empty reader (measured — the
    # obvious-looking stream read returns ''). Keep the stream as a fallback for
    # hosts where ErrorDetails is not populated.
    $detail = ""
    try { $detail = "$($_.ErrorDetails.Message)" } catch { }
    if (-not $detail) {
        try {
            $r = $_.Exception.Response
            if ($r) {
                $sr = New-Object System.IO.StreamReader($r.GetResponseStream())
                $detail = $sr.ReadToEnd()
                $sr.Close()
            }
        } catch { }
    }
    if ($detail) {
        if ($detail.Length -gt 800) { $detail = $detail.Substring(0, 800) + "…" }
        Write-Warning "[push-telemetry] Push failed: $($_.Exception.Message)`n  server said: $detail"
    } else {
        Write-Warning "[push-telemetry] Push failed: $($_.Exception.Message)"
    }
}
exit 0
