#!/usr/bin/env bash
# PreToolUse hook — Runtime Guard (H4), bash parity version.
# Reads risk-policy.yaml (SSOT) to decide allow/deny for tool calls.
# C2: Reads YAML config — never hardcode deny rules in this script.
# C10: Local hook is defense-in-depth; high-risk needs server-side PDP.

set -euo pipefail

INPUT_JSON=""
if [ ! -t 0 ]; then
    INPUT_JSON=$(cat)
fi

if [ -z "$INPUT_JSON" ]; then
    exit 0
fi

# Claude Code's PreToolUse payload uses tool_name / tool_input; accept the
# older tool / input shape too.
TOOL_NAME=$(echo "$INPUT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name') or d.get('tool') or '')" 2>/dev/null || echo "")
TOOL_INPUT=$(echo "$INPUT_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('tool_input') or d.get('input') or {}))" 2>/dev/null || echo "{}")

HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
RISK_POLICY="$HARNESS_ROOT/.harness/control/risk-policy.yaml"

if [ ! -f "$RISK_POLICY" ]; then
    exit 0
fi

# Extract deny patterns from YAML (simple grep-based parser)
DENY_PATTERNS=$(python3 -c "
import re, yaml, sys
try:
    # utf-8-sig: explicit encoding (locale-independent) + strips BOM if present
    with open('$RISK_POLICY', 'r', encoding='utf-8-sig') as f:
        data = yaml.safe_load(f)
    patterns = [p['pattern'] for p in data.get('command_deny_patterns', [])]
    for pat in patterns:
        print(pat)
except Exception:
    pass
" 2>/dev/null)

# Build command string
COMMAND_STRING=""
if [ -n "$TOOL_INPUT" ] && [ "$TOOL_INPUT" != "{}" ]; then
    COMMAND_STRING=$(echo "$TOOL_INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('command', d.get('script', '')))
" 2>/dev/null)
fi

# Persist a deny so the Portal ingest can pick it up (C9 + portal-spec §9):
#   1. .harness/telemetry/security-events.jsonl  -> security_incidents (authoritative)
#   2. .harness/ledger/chain.jsonl deny entry    -> action_log (blocked count)
persist_deny() {
    local tool="$1" pattern="$2" cmd="$3"
    local tel_dir="$HARNESS_ROOT/.harness/telemetry"
    mkdir -p "$tel_dir"
    GUARD_TOOL="$tool" GUARD_PATTERN="$pattern" GUARD_CMD="$cmd" \
    GUARD_EVENTS_FILE="$tel_dir/security-events.jsonl" \
    GUARD_USER="${HARNESS_USER:-${USER:-}}" GUARD_SESSION="${HARNESS_SESSION_ID:-}" \
    python3 - <<'PY' 2>/dev/null || true
import os, json, hashlib, datetime
ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tool = os.environ.get("GUARD_TOOL", "")
pattern = os.environ.get("GUARD_PATTERN", "")
cmd = os.environ.get("GUARD_CMD", "")
event_id = "se-" + hashlib.sha256(f"{ts}|{tool}|{pattern}|{cmd}".encode()).hexdigest()[:24]
cmd_snip = cmd[:240]
event = {
    "event_id": event_id,
    "timestamp": ts,
    "type": "guard_block",
    "severity": "high",
    "category": tool[:50],
    "excerpt": f'blocked command: "{cmd_snip}" | matched deny-pattern: {pattern}',
    "detected_by": "harness-runtime-guard.sh",
    "actor_user": os.environ.get("GUARD_USER", ""),
    "session_id": os.environ.get("GUARD_SESSION", ""),
}
with open(os.environ["GUARD_EVENTS_FILE"], "a", encoding="utf-8") as f:
    f.write(json.dumps(event) + "\n")
PY
    # Ledger deny entry (best-effort; never block the guard decision on it)
    local ledger="$HARNESS_ROOT/.harness/scripts/bash/evidence-ledger.sh"
    if [ -x "$ledger" ] || [ -f "$ledger" ]; then
        local input_hash
        input_hash=$(printf '%s' "$cmd" | sha256sum | cut -d' ' -f1)
        local entry
        entry=$(GUARD_TOOL="$tool" GUARD_PATTERN="$pattern" GUARD_HASH="$input_hash" \
                GUARD_USER="${HARNESS_USER:-${USER:-}}" GUARD_SESSION="${HARNESS_SESSION_ID:-}" \
                python3 -c "
import os, json
print(json.dumps({
    'actor': {'agent': 'claude-code', 'user': os.environ.get('GUARD_USER',''), 'session_id': os.environ.get('GUARD_SESSION',''), 'role': 'member'},
    'action': {'type': 'tool_call', 'tool': os.environ.get('GUARD_TOOL',''), 'description': 'blocked by runtime guard', 'input_hash': os.environ.get('GUARD_HASH',''), 'output_hash': ''},
    'decision': {'result': 'deny', 'reason': 'deny pattern: ' + os.environ.get('GUARD_PATTERN',''), 'risk_level': 'high'},
}))" 2>/dev/null)
        [ -n "$entry" ] && bash "$ledger" append --entry-json "$entry" >/dev/null 2>&1 || true
    fi
}

# Check each deny pattern
while IFS= read -r pattern; do
    [ -z "$pattern" ] && continue
    if echo "$COMMAND_STRING" | grep -qE "$pattern"; then
        REASON="Command matched deny pattern: $pattern"
        persist_deny "$TOOL_NAME" "$pattern" "$COMMAND_STRING" || true
        echo "{\"permissionDecision\":\"deny\",\"reason\":\"$REASON\",\"tool\":\"$TOOL_NAME\"}"
        exit 2
    fi
done <<< "$DENY_PATTERNS"

# --- Server-side PDP consult (H4/H5) — opt-in via portal-sync.json pdp_enforce.
# Best-effort/fail-open (C10: defense-in-depth + server decision, not a hard
# boundary). Only for high-risk shapes, to avoid latency on ordinary calls.
SYNC_CFG="$HARNESS_ROOT/.harness/portal-sync.json"
if [ -n "$COMMAND_STRING" ] && [ -f "$SYNC_CFG" ]; then
    PDP_JSON=$(SYNC_CFG="$SYNC_CFG" TOOL="$TOOL_NAME" CMD="$COMMAND_STRING" \
      HARNESS_ROOT="$HARNESS_ROOT" KEY_ENV="${HARNESS_PORTAL_INGEST_KEY:-}" \
      SESSION="${HARNESS_SESSION_ID:-}" python3 - <<'PY' 2>/dev/null || true
import os, json, re, urllib.request
try:
    cfg = json.load(open(os.environ["SYNC_CFG"], encoding="utf-8-sig"))
except Exception:
    raise SystemExit
if not (cfg.get("pdp_enforce") is True and cfg.get("portal_url") and cfg.get("project_id")):
    raise SystemExit
tool = os.environ.get("TOOL", ""); cmd = os.environ.get("CMD", "")
high = re.search(r"(?i)\b(curl|wget|Invoke-WebRequest|iwr|nc|ncat|http_fetch|deploy|docker\s+compose\s+up|drop\s+table|truncate\s+table|delete\s+from|alter\s+table)\b", cmd) \
       or tool in ("deploy","rollback_deploy","mysql_query","exec_in_container","http_fetch")
if not high:
    raise SystemExit
key = os.environ.get("KEY_ENV") or ""
if not key:
    kf = os.path.join(os.environ["HARNESS_ROOT"], ".harness", "portal-sync.key")
    if os.path.isfile(kf):
        key = open(kf, encoding="utf-8").read().strip()
if not key:
    raise SystemExit
url = cfg["portal_url"].rstrip("/") + "/api/pdp/" + cfg["project_id"] + "/decide"
body = json.dumps({"tool": tool, "command": cmd, "actor": os.environ.get("SESSION", "")}).encode()
req = urllib.request.Request(url, data=body, method="POST",
    headers={"Content-Type": "application/json", "X-Ingest-Key": key, "User-Agent": "harness-runtime-guard/1.0"})
try:
    with urllib.request.urlopen(req, timeout=8) as r:
        d = json.load(r)
    print(json.dumps({"decision": d.get("decision"), "reason": d.get("reason", ""), "approval_id": d.get("approval_id", "")}))
except Exception:
    raise SystemExit
PY
)
    if [ -n "$PDP_JSON" ]; then
        PDP_DECISION=$(echo "$PDP_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('decision',''))" 2>/dev/null)
        if [ "$PDP_DECISION" = "deny" ] || [ "$PDP_DECISION" = "ask" ]; then
            PDP_REASON=$(echo "$PDP_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
            persist_deny "$TOOL_NAME" "pdp:$PDP_DECISION" "$COMMAND_STRING" || true
            echo "{\"permissionDecision\":\"deny\",\"reason\":\"PDP $PDP_DECISION: $PDP_REASON\",\"tool\":\"$TOOL_NAME\"}"
            exit 2
        fi
    fi
fi

exit 0
