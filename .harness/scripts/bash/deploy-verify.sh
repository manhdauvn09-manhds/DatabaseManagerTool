#!/usr/bin/env bash
# Post-deploy verification / transaction boundary (H7) -- PostToolUse hook.
# POSIX parity of deploy-verify.ps1 (C7).
#
# After a deploy, run the smoke check. On failure, BLOCK the flow and demand a
# rollback, and write the incident into the hash-chain ledger.
#
# Answers H7's question: if a later step fails after an earlier one already ran,
# can the pipeline recover?
#
# C2: URL, expected string and retry counts come from casan-policies.yaml
#     (orchestration.transaction.*), never hardcoded.
# C10: this hook DETECTS the failure and blocks the flow. It cannot call
#      rollback_deploy itself -- a hook has no access to MCP tools. The rollback
#      is done by the agent or the human after reading the warning. Do not call
#      this auto-rollback.
set -uo pipefail

INPUT="$(cat || true)"
[ -n "$INPUT" ] || exit 0

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HARNESS_ROOT:-$(cd "$DIR/../../.." && pwd)}"
POLICY="$ROOT/.harness/control/casan-policies.yaml"
[ -f "$POLICY" ] || exit 0

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || exit 0

TOOL=$(HARNESS_HOOK_INPUT="$INPUT" "$PY" -c '
import json, os
try:
    d = json.loads(os.environ.get("HARNESS_HOOK_INPUT", ""))
except Exception:
    raise SystemExit(0)
print(d.get("tool_name") or d.get("tool") or "")
' 2>/dev/null || true)
[ -n "$TOOL" ] || exit 0

# Only deploys. NOT rollback_deploy: a failed rollback has its own warning, and
# smoke-checking after a rollback would loop the warning back on itself.
case "$TOOL" in
  *rollback_deploy) exit 0 ;;
  *deploy|*deploy_safe) : ;;
  *) exit 0 ;;
esac

# --- orchestration.transaction.* (C2) ------------------------------------
CONF=$(HARNESS_POLICY="$POLICY" "$PY" - <<'PY' 2>/dev/null || true
import json, os, re

url, expect, timeout, retries, delay = None, "ok", 20, 3, 5
try:
    with open(os.environ["HARNESS_POLICY"], encoding="utf-8-sig", errors="replace") as f:
        lines = f.read().splitlines()
except OSError:
    raise SystemExit(0)

in_orch = False
for line in lines:
    if re.match(r"^orchestration:", line):
        in_orch = True
        continue
    if in_orch and re.match(r"^[a-z_]+:", line):
        break
    if not in_orch:
        continue
    m = re.match(r'^\s+smoke_url:\s*"([^"]+)"', line)
    if m:
        url = m.group(1); continue
    m = re.match(r'^\s+smoke_expect:\s*"([^"]*)"', line)
    if m:
        expect = m.group(1); continue
    m = re.match(r"^\s+smoke_timeout_seconds:\s*(\d+)", line)
    if m:
        timeout = int(m.group(1)); continue
    m = re.match(r"^\s+smoke_retries:\s*(\d+)", line)
    if m:
        retries = int(m.group(1)); continue
    m = re.match(r"^\s+smoke_retry_delay_seconds:\s*(\d+)", line)
    if m:
        delay = int(m.group(1)); continue

if not url:
    raise SystemExit(0)   # not configured -> do nothing
print(json.dumps({"url": url, "expect": expect, "timeout": timeout,
                  "retries": retries, "delay": delay}, separators=(",", ":")))
PY
)
# Not configured is not a failure: say nothing rather than invent a verdict.
[ -n "$CONF" ] || exit 0

eval "$(HARNESS_CONF="$CONF" "$PY" - <<'PY'
import json, os, shlex
c = json.loads(os.environ["HARNESS_CONF"])
for k in ("url", "expect", "timeout", "retries", "delay"):
    print("SMOKE_%s=%s" % (k.upper(), shlex.quote(str(c[k]))))
PY
)"

# --- smoke check with retries (a container needs a few seconds) -----------
OK=0
LAST_ERR=""
i=1
while [ "$i" -le "$SMOKE_RETRIES" ]; do
  BODY_FILE="$(mktemp)"
  CODE=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' --max-time "$SMOKE_TIMEOUT" "$SMOKE_URL" 2>"$BODY_FILE.err" || echo "000")
  if [ "$CODE" -ge 200 ] 2>/dev/null && [ "$CODE" -lt 300 ] 2>/dev/null; then
    if [ -z "$SMOKE_EXPECT" ] || grep -qF -- "$SMOKE_EXPECT" "$BODY_FILE"; then
      OK=1
      rm -f "$BODY_FILE" "$BODY_FILE.err"
      break
    fi
    LAST_ERR="HTTP $CODE, body khong chua '$SMOKE_EXPECT'"
  elif [ "$CODE" = "000" ]; then
    LAST_ERR="$(tr -d '\n' < "$BODY_FILE.err" 2>/dev/null | head -c 300)"
    [ -n "$LAST_ERR" ] || LAST_ERR="khong ket noi duoc toi $SMOKE_URL"
  else
    LAST_ERR="HTTP $CODE"
  fi
  rm -f "$BODY_FILE" "$BODY_FILE.err"
  [ "$i" -lt "$SMOKE_RETRIES" ] && sleep "$SMOKE_DELAY"
  i=$((i + 1))
done

# --- ledger ---------------------------------------------------------------
LEDGER="$DIR/evidence-ledger.sh"
if [ -f "$LEDGER" ]; then
  ENTRY=$(SMOKE_OK="$OK" SMOKE_URL="$SMOKE_URL" SMOKE_ERR="$LAST_ERR" TOOL="$TOOL" \
          HOOK_SESSION="${HARNESS_SESSION_ID:-}" HOOK_USER="${HARNESS_USER:-${USER:-}}" \
          HOOK_AGENT="${HARNESS_AGENT_NAME:-}" "$PY" - <<'PY' 2>/dev/null || true
import json, os
ok = os.environ["SMOKE_OK"] == "1"
url, err = os.environ["SMOKE_URL"], os.environ.get("SMOKE_ERR", "")
print(json.dumps({
    "actor": {"agent": os.environ.get("HOOK_AGENT", ""),
              "user": os.environ.get("HOOK_USER", ""),
              "session_id": os.environ.get("HOOK_SESSION", ""),
              "role": "member"},
    "action": {"type": "pipeline_event", "tool": os.environ.get("TOOL", ""),
               "description": ("post-deploy smoke check PASSED (%s)" % url) if ok
                              else ("post-deploy smoke check FAILED (%s): %s" % (url, err))},
    "decision": {"result": "allow" if ok else "deny",
                 "reason": "healthy" if ok else err,
                 "risk_level": "none" if ok else "critical"},
}, separators=(",", ":")))
PY
)
  if [ -n "$ENTRY" ]; then
    bash "$LEDGER" append --entry-json "$ENTRY" >/dev/null 2>&1 || true
  fi
fi

[ "$OK" = "1" ] && exit 0

# --- failed => block the flow and make the agent deal with it -------------
SMOKE_URL="$SMOKE_URL" SMOKE_ERR="$LAST_ERR" SMOKE_RETRIES="$SMOKE_RETRIES" "$PY" - <<'PY'
import json, os
print(json.dumps({
    "decision": "block",
    "reason": (
        "H7 TRANSACTION BOUNDARY: deploy xong nhung smoke check FAIL sau %s lan thu.\n"
        "URL : %s\n"
        "Loi : %s\n\n"
        "Production co the dang HONG. Hanh dong bat buoc ngay:\n"
        "  1. Goi rollback_deploy (server_id mcp-80, app_id dbmanager)\n"
        "  2. Xac nhan lai health sau rollback\n"
        "  3. Bao nguoi dung nguyen nhan truoc khi deploy lai\n"
        "KHONG duoc bo qua canh bao nay va lam viec khac."
        % (os.environ["SMOKE_RETRIES"], os.environ["SMOKE_URL"], os.environ.get("SMOKE_ERR", ""))
    ),
}, separators=(",", ":")))
PY

exit 0
