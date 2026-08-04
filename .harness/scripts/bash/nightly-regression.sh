#!/usr/bin/env bash
# nightly-regression.sh - ban bash cua nightly-regression.ps1 (H3/H6).
#
# Dung cho server Linux (mcp-80) noi KHONG co PowerShell. Chay cung 4 suite,
# doc lenh tu casan-policies.yaml (evaluation.suite_commands) - C2, khong hardcode.
#
# Khac ban .ps1 mot diem: server khong co ledger cua agent (moi hoat dong agent
# nam o may dev), nen script chi append ledger NEU evidence-ledger.sh + thu muc
# ledger ton tai. Khong co thi bo qua, van chay test binh thuong.
#
# Dung:
#   ./nightly-regression.sh              # chay tu repo root
#   ./nightly-regression.sh -q           # quiet, cho cron
#   REPO_DIR=/opt/dbmanager ./nightly-regression.sh
#
# Exit: 0 = tat ca PASS, 1 = co suite FAIL, 2 = thieu tien de

set -uo pipefail

QUIET=0
[ "${1:-}" = "-q" ] && QUIET=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
POLICY="$REPO_DIR/.harness/control/casan-policies.yaml"

info() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
err()  { printf '%s\n' "$*" >&2; }

# --- Tien de -------------------------------------------------------------
if [ ! -f "$POLICY" ]; then
  err "[nightly] THIEU: $POLICY"
  err "[nightly] Server dang chay ban harness cu (khong co CASAN policy pack)."
  err "[nightly] Can dong bo tu repo dev nhung thu sau roi chay lai:"
  err "          .harness/control/casan-policies.yaml"
  err "          .harness/eval/golden/          (golden dataset)"
  err "          .harness/scripts/lib/*.py      (policy-ci, red-team, golden)"
  exit 2
fi

# --- Doc evaluation.suite_commands (C2) ----------------------------------
# Lay cac dong 'ten: "lenh"' nam duoi suite_commands, trong section evaluation.
SUITES="$(awk '
  /^evaluation:/            { in_eval=1; next }
  in_eval && /^[a-z_]+:/    { exit }
  in_eval && /^[[:space:]]+suite_commands:/ { in_cmds=1; next }
  in_cmds {
    if (match($0, /^[[:space:]]+([a-z0-9_-]+):[[:space:]]*"([^"]+)"/, m)) {
      print m[1] "\t" m[2]
    } else if ($0 ~ /^[[:space:]]+[a-z_]+:[[:space:]]*$/) {
      exit
    }
  }
' "$POLICY" 2>/dev/null)"

# awk cua BusyBox/mawk khong co match() 3 doi so -> fallback sed.
if [ -z "$SUITES" ]; then
  SUITES="$(sed -n '/^evaluation:/,/^[a-z_]*:/p' "$POLICY" \
    | sed -n '/suite_commands:/,$p' \
    | sed -n 's/^[[:space:]]\{1,\}\([a-z0-9_-]\{1,\}\):[[:space:]]*"\([^"]*\)".*/\1\t\2/p')"
fi

if [ -z "$SUITES" ]; then
  err "[nightly] Khong doc duoc evaluation.suite_commands tu $POLICY"
  exit 2
fi

info "=== Nightly regression - $(date '+%Y-%m-%d %H:%M') ==="
info "Repo: $REPO_DIR"
info "So suite: $(printf '%s\n' "$SUITES" | wc -l)"
info ""

# --- Chay tung suite -----------------------------------------------------
cd "$REPO_DIR" || { err "[nightly] khong vao duoc $REPO_DIR"; exit 2; }

FAILED=""
TOTAL=0
declare -a LINES=()

while IFS=$'\t' read -r name cmd; do
  [ -z "$name" ] && continue
  TOTAL=$((TOTAL + 1))
  info "[$name] $cmd"
  start=$(date +%s)
  out="$(eval "$cmd" 2>&1)"
  code=$?
  dur=$(( $(date +%s) - start ))

  if [ $code -eq 0 ]; then
    info "  -> PASS (${dur}s)"
    LINES+=("  $(printf '%-22s PASS %6ss' "$name" "$dur")")
  else
    info "  -> FAIL (exit $code, ${dur}s)"
    LINES+=("  $(printf '%-22s FAIL %6ss' "$name" "$dur")")
    FAILED="$FAILED $name"
    # Giu lai duoi output de in o cuoi.
    printf '%s\n' "$out" | tail -25 > "/tmp/nightly-$name.tail"
  fi
  info ""
done <<< "$SUITES"

# --- Ghi ledger neu co ---------------------------------------------------
LEDGER_SH="$REPO_DIR/.harness/scripts/bash/evidence-ledger.sh"
if [ -x "$LEDGER_SH" ] || [ -f "$LEDGER_SH" ]; then
  if [ -z "$FAILED" ]; then
    desc="nightly full-suite PASSED ($TOTAL suites)"; result="allow"; risk="none"; reason="all suites green"
  else
    desc="nightly full-suite FAILED:$FAILED"; result="deny"; risk="high"; reason="test_regression_after_pass"
  fi
  entry=$(printf '{"actor":{"agent":"nightly-regression","user":"%s","session_id":"nightly-%s","role":"system"},"action":{"type":"pipeline_event","tool":"nightly-regression","description":"%s"},"decision":{"result":"%s","reason":"%s","risk_level":"%s"}}' \
    "${HARNESS_USER:-cron}" "$(date +%Y%m%d)" "$desc" "$result" "$reason" "$risk")
  bash "$LEDGER_SH" append --entry-json "$entry" >/dev/null 2>&1 || true
fi

# --- Bao cao -------------------------------------------------------------
info "=== Ket qua ==="
for l in "${LINES[@]:-}"; do info "$l"; done

if [ -z "$FAILED" ]; then
  echo "[nightly] ALL PASS - $TOTAL suites"
  exit 0
fi

echo "[nightly] FAIL:$FAILED"
echo ""
echo "INCIDENT test_regression_after_pass"
echo "Neu impact-test trong ngay deu PASS ma full suite FAIL, nghia la co file nam"
echo "NGOAI dependency graph ma test khong lan toi duoc. Xu ly:"
echo "  1. Xem test nao fail o output duoi"
echo "  2. Tim file source lien quan"
echo "  3. Them file do vao core_files trong"
echo "     .claude/skills/change-pipeline/pipeline-config.yaml"
echo ""
for name in $FAILED; do
  echo "--- $name ---"
  cat "/tmp/nightly-$name.tail" 2>/dev/null
  rm -f "/tmp/nightly-$name.tail"
  echo ""
done
exit 1
