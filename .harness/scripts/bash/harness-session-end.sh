#!/usr/bin/env bash
# SessionEnd hook (POSIX parity of harness-session-end.ps1). Archives session
# telemetry and cleans up the session temp workspace.
set -euo pipefail

HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
SID="${HARNESS_SESSION_ID:-unknown}"
TEL="$HARNESS_ROOT/.harness/telemetry"

# Capture stdin once (hook JSON) so we can both archive and sample it.
INPUT=""
if [ ! -t 0 ]; then
  INPUT=$(cat || true)
fi

# H6: sample the whole session's real token usage from the transcript.
# SubagentStop only covers subagents; this covers the main agent.
if [ -n "$INPUT" ] && [ -f "$HARNESS_ROOT/.harness/scripts/bash/agentops-sampler.sh" ]; then
  printf '%s' "$INPUT" | bash "$HARNESS_ROOT/.harness/scripts/bash/agentops-sampler.sh" >/dev/null 2>&1 || true
fi

# Push telemetry to the Control Portal if configured (.harness/portal-sync.json)
# — the sync path for checkouts the backend can't read. Best-effort.
if [ -f "$HARNESS_ROOT/.harness/scripts/bash/push-telemetry.sh" ]; then
  bash "$HARNESS_ROOT/.harness/scripts/bash/push-telemetry.sh" >/dev/null 2>&1 || true
fi

if [ -f "$TEL/tool-calls.log" ]; then
  cp -f "$TEL/tool-calls.log" "$TEL/session-$SID-$(date +%Y%m%d%H%M%S).log"
fi
[ -d "$HARNESS_ROOT/.harness/tmp/$SID" ] && rm -rf "$HARNESS_ROOT/.harness/tmp/$SID" || true

echo "[harness] Session $SID ended at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit 0
