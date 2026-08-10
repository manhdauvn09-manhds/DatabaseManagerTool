#!/usr/bin/env bash
# Shell-side helpers for the idempotency hooks (H2). POSIX parity of
# lib-idempotency.ps1 (C7).
#
# The shared LOGIC -- key derivation, policy parsing, the write-vs-read reading
# of mysql_query -- lives in lib_idempotency.py next to this file, imported by
# both hooks. It is a real module and not a shell string spliced into a heredoc
# because an unquoted heredoc lets bash interpret `$` and `\` inside the Python
# source, quietly turning a regex into something else.
#
# Sourced by idempotency-checkpoint.sh and idempotency-record.sh.

harness_root() {
  if [ -n "${HARNESS_ROOT:-}" ]; then
    printf '%s' "$HARNESS_ROOT"
  else
    (cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
  fi
}

harness_python() {
  command -v python3 || command -v python || true
}

# Lock store: shared with the toolkit's tool-idempotency, but our files carry a
# .hook.json suffix so the two never collide.
lock_store_dir() {
  local dir="$1/.harness/ledger/idempotency"
  mkdir -p "$dir" 2>/dev/null || true
  printf '%s' "$dir"
}
