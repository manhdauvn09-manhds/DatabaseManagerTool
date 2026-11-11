#!/usr/bin/env bash
# C16 worktree budget -- POSIX parity of harness-worktree.ps1. Thin wrapper over
# .harness/scripts/lib/harness_worktree.py so both shells decide identically (C7).
#   bash harness-worktree.sh status [--json]
#   bash harness-worktree.sh finish [--path WORKTREE] [--no-push]   (merge, push, remove, branch -d)
#   bash harness-worktree.sh install-git-hook
#   bash harness-worktree.sh start|stop     (hook modes: stdin JSON, always exit 0)
# Local defense-in-depth (C10).
ROOT="$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd)" || exit 1
LIB="$ROOT/.harness/scripts/lib/harness_worktree.py"
PY="$(command -v python3 || command -v python || true)"
MODE="${1:-status}"
[ $# -gt 0 ] && shift

case "$MODE" in
  start|stop)
    [ -n "$PY" ] && [ -f "$LIB" ] || exit 0
    "$PY" "$LIB" "$MODE" "$ROOT" 2>/dev/null || true
    exit 0 ;;
esac

[ -n "$PY" ] || { echo "python not on PATH"; exit 1; }
[ -f "$LIB" ] || { echo "missing $LIB"; exit 1; }
exec "$PY" "$LIB" "$MODE" "$ROOT" "$@"
