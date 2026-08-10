#!/usr/bin/env bash
# Approval checkpoint (H5) -- PreToolUse hook.
# POSIX parity of approval-checkpoint.ps1 (C7).
#
# Forces a human confirmation before high-risk actions, and records every ask in
# the hash-chain ledger so "who did what, when, and who approved it" has an
# answer.
#
# C2: the action list comes from .harness/control/casan-policies.yaml
#     (governance.approval_required) -- never hardcoded here.
# C10: this is LOCAL enforcement. It constrains an agent running in Claude Code
#      in this repo; it does not replace the server-side gateway PDP. It
#      supplements `enforced_at: gateway`, it does not stand in for it.
#
# Output: permissionDecision="ask" on stdout, which makes Claude Code prompt the
# user. exit 0 with no output means no approval needed.
#
# Best-effort: every internal error exits 0 (fail-open). A broken hook must not
# wedge a session; hard denies are harness-runtime-guard.sh's job.
set -uo pipefail

INPUT="$(cat || true)"
[ -n "$INPUT" ] || exit 0

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HARNESS_ROOT:-$(cd "$DIR/../../.." && pwd)}"
POLICY="$ROOT/.harness/control/casan-policies.yaml"
[ -f "$POLICY" ] || exit 0

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || exit 0

# Emits {matched, input_hash} when approval is required, else nothing.
DECISION=$(HARNESS_HOOK_INPUT="$INPUT" HARNESS_POLICY="$POLICY" HARNESS_LIBDIR="$DIR" \
  "$PY" - <<'PY' 2>/dev/null || true
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.environ["HARNESS_LIBDIR"])
from lib_idempotency import hook_record, input_of, policy_list, tool_of

d = hook_record()
if not d:
    raise SystemExit(0)
tool = tool_of(d)
if not tool:
    raise SystemExit(0)
tin = input_of(d)

required = policy_list(os.environ["HARNESS_POLICY"], "governance", "approval_required")
if not required:
    raise SystemExit(0)

# Matches an MCP tool (mcp__<server>__deploy) as well as a bare name (deploy).
# Mirrors the .ps1 patterns exactly, including "*__<r>_*".
matched = None
for r in required:
    if tool == r or tool.endswith("__" + r) or re.search(r"__%s_" % re.escape(r), tool):
        matched = r
        break
if not matched:
    raise SystemExit(0)

# mysql_query needs approval only when it WRITES (the policy says so in a
# comment, and both shells must read it the same way).
if matched == "mysql_query":
    ti = tin if isinstance(tin, dict) else {}
    sql = "%s%s" % (ti.get("query") or "", ti.get("sql") or "")
    if sql and not re.search(
            r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b",
            sql, re.I | re.S):
        raise SystemExit(0)

canon = json.dumps(tin, separators=(",", ":")) if tin else "{}"
print(json.dumps({
    "matched": matched,
    "input_hash": hashlib.sha256(canon.encode("utf-8")).hexdigest(),
}, separators=(",", ":")))
PY
)

[ -n "$DECISION" ] || exit 0

# --- record that we ASKED (not that it was approved) ----------------------
LEDGER="$DIR/evidence-ledger.sh"
if [ -f "$LEDGER" ]; then
  ENTRY=$(HARNESS_DECISION="$DECISION" HARNESS_HOOK_INPUT="$INPUT" \
          HOOK_SESSION="${HARNESS_SESSION_ID:-}" HOOK_USER="${HARNESS_USER:-${USER:-}}" \
          HOOK_AGENT="${HARNESS_AGENT_NAME:-}" "$PY" - <<'PY' 2>/dev/null || true
import json, os
dec = json.loads(os.environ["HARNESS_DECISION"])
d = json.loads(os.environ.get("HARNESS_HOOK_INPUT") or "{}")
print(json.dumps({
    "actor": {"agent": os.environ.get("HOOK_AGENT", ""),
              "user": os.environ.get("HOOK_USER", ""),
              "session_id": os.environ.get("HOOK_SESSION", ""),
              "role": "member"},
    "action": {"type": "approval",
               "tool": d.get("tool_name") or d.get("tool") or "",
               "description": "approval requested for high-risk action '%s'" % dec["matched"],
               "input_hash": dec["input_hash"]},
    "decision": {"result": "ask",
                 "reason": "governance.approval_required contains '%s'" % dec["matched"],
                 "risk_level": "high"},
}, separators=(",", ":")))
PY
)
  if [ -n "$ENTRY" ]; then
    bash "$LEDGER" append --entry-json "$ENTRY" >/dev/null 2>&1 || true
  fi
fi

HARNESS_DECISION="$DECISION" "$PY" - <<'PY'
import json, os
dec = json.loads(os.environ["HARNESS_DECISION"])
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason":
        "H5 approval checkpoint: '%s' nam trong governance.approval_required. "
        "Da ghi vao ledger. Xac nhan de tiep tuc." % dec["matched"],
}}, separators=(",", ":")))
PY

exit 0
