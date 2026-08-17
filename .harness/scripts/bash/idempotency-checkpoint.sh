#!/usr/bin/env bash
# Idempotency + rate-limit checkpoint (H2) -- PreToolUse hook.
# POSIX parity of idempotency-checkpoint.ps1 (C7).
#
# Answers H2's question: if this tool call runs twice, is the system still safe?
#   1. IDEMPOTENCY -- for a tool in tool.idempotency_required, a SUCCESSFUL run
#      with the same key (tool + input) inside the TTL means ask again.
#   2. RATE LIMIT  -- successful calls counted in a sliding window per
#      tool.rate_limits; over the threshold means ask again.
#
# C2: both are read from .harness/control/casan-policies.yaml.
# C10: this hook can only ASK. It cannot hand back a cached result in place of
#      the tool, and it is LOCAL enforcement -- it does not replace the gateway
#      PDP. Whether the call really happens is the human's decision at the
#      prompt.
#
# Only SUCCESSFUL runs are recorded (idempotency-record.sh, PostToolUse), so a
# failure followed by a retry is never blocked for the wrong reason.
#
# Fail-open by design: any internal error exits 0. A broken advisory hook must
# not wedge a session -- hard denies are harness-runtime-guard.sh's job.
set -uo pipefail

INPUT="$(cat || true)"
[ -n "$INPUT" ] || exit 0

DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib-idempotency.sh
. "$DIR/lib-idempotency.sh" 2>/dev/null || exit 0

ROOT="$(harness_root)"
POLICY="$ROOT/.harness/control/casan-policies.yaml"
[ -f "$POLICY" ] || exit 0

PY="$(harness_python)"
[ -n "$PY" ] || exit 0

LOCKDIR="$(lock_store_dir "$ROOT")"

# Emits one JSON object {reason, key, base} when it wants to ask, else nothing.
DECISION=$(HARNESS_HOOK_INPUT="$INPUT" HARNESS_POLICY="$POLICY" \
           HARNESS_LOCKDIR="$LOCKDIR" HARNESS_LIBDIR="$DIR" \
  "$PY" - <<'PY' 2>/dev/null || true
import datetime
import glob
import json
import os
import sys
import time

sys.path.insert(0, os.environ["HARNESS_LIBDIR"])
from lib_idempotency import (LOCK_SUFFIX, hook_record, idempotency_key, input_of,
                             is_write_call, policy_list, policy_scalar,
                             rate_limit_for, resolve_tool, tool_of)

d = hook_record()
if not d:
    raise SystemExit(0)
tool = tool_of(d)
if not tool:
    raise SystemExit(0)
tin = input_of(d)

policy = os.environ["HARNESS_POLICY"]
lockdir = os.environ["HARNESS_LOCKDIR"]

required = policy_list(policy, "tool", "idempotency_required")
if not required:
    raise SystemExit(0)
base = resolve_tool(tool, required)
if not base or not is_write_call(base, tin):
    raise SystemExit(0)

ttl = policy_scalar(policy, "tool", "idempotency_ttl_seconds", 3600)
key = idempotency_key(tool, tin)
reason = None

# --- 1. same key inside the TTL? -----------------------------------------
lock = os.path.join(lockdir, key + LOCK_SUFFIX)
if os.path.isfile(lock):
    try:
        with open(lock, encoding="utf-8-sig") as f:
            prev = json.load(f)
        then = datetime.datetime.fromisoformat(prev["executed_at"].replace("Z", "+00:00"))
        now = datetime.datetime.now(then.tzinfo) if then.tzinfo else datetime.datetime.now()
        age = (now - then).total_seconds()
        if 0 <= age < ttl:
            reason = ("H2 idempotency: '%s' da chay THANH CONG voi dung input nay cach day "
                      "%.1f phut (key %s). Chay lai co the nhan doi side-effect. "
                      "Xac nhan neu that su muon chay lai." % (base, age / 60.0, key[:12]))
    except Exception:
        # An unreadable lock is worse than no lock: it would suppress the check
        # forever while looking like coverage. Drop it; the next successful run
        # writes a good one.
        try:
            os.remove(lock)
        except OSError:
            pass

# --- 2. rate limit --------------------------------------------------------
if not reason:
    try:
        unit, count = rate_limit_for(policy, base)
        if unit:
            cutoff = time.time() - (3600 if unit == "hour" else 60)
            recent = 0
            for p in glob.glob(os.path.join(lockdir, "*" + LOCK_SUFFIX)):
                try:
                    if os.path.getmtime(p) <= cutoff:
                        continue
                    with open(p, encoding="utf-8-sig") as f:
                        rec = json.load(f)
                    if rec.get("base") == base:
                        recent += 1
                except Exception:
                    continue
            if recent >= count:
                reason = ("H2 rate limit: '%s' da chay %d lan trong 1 %s (nguong %d). "
                          "Xac nhan neu that su can chay tiep." % (base, recent, unit, count))
    except Exception:
        # Rate limiting is best-effort and must not break the checkpoint.
        pass

if not reason:
    raise SystemExit(0)

print(json.dumps({"reason": reason, "key": key, "base": base}, separators=(",", ":")))
PY
)

[ -n "$DECISION" ] || exit 0

# --- record that we ASKED, then ask ---------------------------------------
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
    "action": {"type": "decision",
               "tool": d.get("tool_name") or d.get("tool") or "",
               "description": "idempotency/rate-limit checkpoint triggered for '%s'" % dec["base"],
               "input_hash": dec["key"]},
    "decision": {"result": "ask", "reason": dec["reason"], "risk_level": "medium"},
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
    "permissionDecisionReason": dec["reason"],
}}, separators=(",", ":")))
PY

exit 0
