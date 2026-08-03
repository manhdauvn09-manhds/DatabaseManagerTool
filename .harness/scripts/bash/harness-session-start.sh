#!/usr/bin/env bash
# SessionStart hook (POSIX parity of harness-session-start.ps1). Initialises
# per-session state: verifies .harness/ layout, makes a session temp dir, emits
# a start line. Defense-in-depth, bypassable locally.
set -euo pipefail

HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
SID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null \
      || python3 -c 'import uuid;print(uuid.uuid4())' 2>/dev/null || date +%s)"

for d in ".harness/control" ".harness/scripts/bash" ".harness/ledger" ".harness/telemetry" "contracts"; do
  [ -d "$HARNESS_ROOT/$d" ] || echo "[harness-session-start] Missing directory: $d" >&2
done

mkdir -p "$HARNESS_ROOT/.harness/tmp/$SID"
export HARNESS_SESSION_ID="$SID"
export HARNESS_ROOT
export HARNESS_SESSION_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# H1 — build/refresh the pipeline-context pointer store (best-effort).
CTX="$(dirname "$0")/harness-context-build.sh"
[ -f "$CTX" ] && HARNESS_ROOT="$HARNESS_ROOT" bash "$CTX" || true

echo "[harness] Session $SID started at $HARNESS_SESSION_START"
exit 0
