#!/usr/bin/env bash
# PostToolUse hook (POSIX parity of harness-post-tool-use.ps1). Appends a
# telemetry line for each completed tool call. Reads the hook JSON on stdin.
set -euo pipefail

HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
TEL="$HARNESS_ROOT/.harness/telemetry"
mkdir -p "$TEL"
INPUT="$(cat || true)"
[ -n "$INPUT" ] || exit 0

PY="$(command -v python3 || command -v python || true)"
if [ -n "$PY" ]; then
  # Pass the hook JSON via env (the heredoc already occupies python's stdin).
  HARNESS_HOOK_INPUT="$INPUT" "$PY" - "$TEL/tool-calls.log" "${HARNESS_SESSION_ID:-}" <<'PY'
import os, json, sys, datetime
log, sid = sys.argv[1], sys.argv[2]
try:
    d = json.loads(os.environ.get("HARNESS_HOOK_INPUT", ""))
except Exception:
    sys.exit(0)
rec = {
    "timestamp": datetime.datetime.now().astimezone().isoformat(),
    "agent": d.get("agent"),
    "tool": d.get("tool_name") or d.get("tool"),
    "success": d.get("success"),
    "session_id": sid,
}
open(log, "a", encoding="utf-8").write(json.dumps(rec) + "\n")
PY

  # C9: every side-effect tool call appends one line to the evidence ledger
  # (identity + input/output hash). Best-effort — never fail the hook on it.
  LEDGER="$HARNESS_ROOT/.harness/scripts/bash/evidence-ledger.sh"
  if [ -f "$LEDGER" ]; then
    ENTRY=$(HARNESS_HOOK_INPUT="$INPUT" HOOK_SESSION="${HARNESS_SESSION_ID:-}" HOOK_USER="${HARNESS_USER:-${USER:-}}" "$PY" - <<'PY' 2>/dev/null || true
import os, json, hashlib
try:
    d = json.loads(os.environ.get("HARNESS_HOOK_INPUT", ""))
except Exception:
    raise SystemExit(0)
tool = d.get("tool_name") or d.get("tool") or ""
tin = json.dumps(d.get("tool_input") or d.get("input") or {}, sort_keys=True)
tout = json.dumps(d.get("tool_response") or d.get("output") or {}, sort_keys=True, default=str)
print(json.dumps({
    "actor": {"agent": d.get("agent") or "claude-code", "user": os.environ.get("HOOK_USER", ""), "session_id": os.environ.get("HOOK_SESSION", ""), "role": "member"},
    "action": {"type": "tool_call", "tool": tool, "description": "completed tool call",
               "input_hash": hashlib.sha256(tin.encode()).hexdigest(),
               "output_hash": hashlib.sha256(tout.encode()).hexdigest()},
    "decision": {"result": "allow", "reason": "completed", "risk_level": "none"},
}))
PY
)
    [ -n "$ENTRY" ] && bash "$LEDGER" append --entry-json "$ENTRY" >/dev/null 2>&1 || true
  fi
fi
exit 0
