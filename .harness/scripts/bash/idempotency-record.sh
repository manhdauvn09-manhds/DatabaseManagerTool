#!/usr/bin/env bash
# Idempotency recorder (H2) -- PostToolUse hook.
# POSIX parity of idempotency-record.ps1 (C7).
#
# Records a SUCCESSFUL run of a tool in tool.idempotency_required, so
# idempotency-checkpoint.sh (PreToolUse) can spot the duplicate next time.
#
# Only on success -- a failure is not recorded, so a retry after an error is
# never blocked for the wrong reason.
#
# A separate file from the toolkit's own scripts on purpose: reinstalling the
# bundle must not overwrite it.
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

HARNESS_HOOK_INPUT="$INPUT" HARNESS_POLICY="$POLICY" HARNESS_LOCKDIR="$LOCKDIR" \
HARNESS_LIBDIR="$DIR" HOOK_SESSION="${HARNESS_SESSION_ID:-}" \
  "$PY" - <<'PY' 2>/dev/null || true
import datetime
import json
import os
import sys

sys.path.insert(0, os.environ["HARNESS_LIBDIR"])
from lib_idempotency import (LOCK_SUFFIX, hook_record, idempotency_key, input_of,
                             is_write_call, policy_list, resolve_tool, tool_of)

d = hook_record()
if not d:
    raise SystemExit(0)
tool = tool_of(d)
if not tool:
    raise SystemExit(0)
tin = input_of(d)

# Record only on success. Claude Code does not always send a success flag, so
# treat the call as successful unless there is a clear sign of failure -- the
# same reading as the .ps1, because a checkpoint that disagrees with its
# recorder about what "succeeded" means is worse than neither.
resp = d.get("tool_response")
if isinstance(resp, dict):
    if resp.get("success") is False or resp.get("error"):
        raise SystemExit(0)
if d.get("tool_success") is False:
    raise SystemExit(0)

policy = os.environ["HARNESS_POLICY"]
required = policy_list(policy, "tool", "idempotency_required")
if not required:
    raise SystemExit(0)
base = resolve_tool(tool, required)
if not base or not is_write_call(base, tin):
    raise SystemExit(0)

try:
    key = idempotency_key(tool, tin)
    rec = {
        "tool": tool,
        "base": base,
        "key": key,
        "executed_at": datetime.datetime.now().astimezone().isoformat(),
        "session_id": os.environ.get("HOOK_SESSION", ""),
    }
    path = os.path.join(os.environ["HARNESS_LOCKDIR"], key + LOCK_SUFFIX)
    # No BOM. The .ps1 writes this with Set-Content -Encoding utf8, which on
    # Windows PowerShell 5.1 always emits one, and a BOM makes the file invalid
    # JSON for anything that does not open it as utf-8-sig. Both readers here
    # cope, but writing one is still writing a file that jq cannot parse.
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(rec, separators=(",", ":")))
except Exception:
    # Best-effort: never fail the hook over bookkeeping.
    pass
PY

exit 0
