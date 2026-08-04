#!/usr/bin/env bash
# H1 Context Harness — build/refresh the pipeline-context pointer store (bash
# parity of harness-context-build.ps1). Turns casan-policies `context` into a
# real .harness/context/pipeline-context.yaml so sub-agents discover inputs
# without re-scanning. Refreshes only when missing or older than the TTL.
set -euo pipefail

HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
POLICY="$HARNESS_ROOT/.harness/control/casan-policies.yaml"
STORE="$HARNESS_ROOT/.harness/context/pipeline-context.yaml"
TTL_MIN=240

if [ -f "$POLICY" ]; then
    ps=$(grep -oE 'pointer_store:[[:space:]]*"?[^"[:space:]]+' "$POLICY" 2>/dev/null | sed -E 's/.*pointer_store:[[:space:]]*"?//' || true)
    [ -n "$ps" ] && STORE="$HARNESS_ROOT/$ps"
    ttl=$(grep -oE 'staleness_ttl_minutes:[[:space:]]*[0-9]+' "$POLICY" 2>/dev/null | grep -oE '[0-9]+' || true)
    [ -n "$ttl" ] && TTL_MIN="$ttl"
fi

# Staleness: skip if fresh.
if [ -f "$STORE" ]; then
    now=$(date +%s); mtime=$(date -r "$STORE" +%s 2>/dev/null || echo 0)
    age_min=$(( (now - mtime) / 60 ))
    if [ "$age_min" -lt "$TTL_MIN" ]; then
        echo "[context] pipeline-context.yaml fresh (${age_min}m < ${TTL_MIN}m) -- kept"
        exit 0
    fi
fi

# Read a YAML string-list under `<key>:` from the policy (C2 - discovery lives in
# config). Naive on purpose: the hook path must not need a YAML dependency.
yaml_list() {
    [ -f "$POLICY" ] || return 0
    # The key line may carry a trailing comment; an absent/empty list must not
    # fail the script (grep exits 1 on no match and pipefail would propagate).
    sed -nE "/^[[:space:]]*$1:[[:space:]]*(#.*)?\$/,/^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*:/p" "$POLICY" \
      | grep -E '^[[:space:]]*-[[:space:]]' \
      | sed -E 's/^[[:space:]]*-[[:space:]]*//; s/[[:space:]]*#.*$//; s/^"//; s/"$//; s/^'\''//; s/'\''$//' \
      || true
}

# Deterministic pointer discovery: an entry with no wildcard is an exact path
# taken when present (canonical wins); a wildcard entry globs recursively and the
# matches are SORTED so the chosen file cannot flip between runs.
find_first() {
    local p hit
    for p in "$@"; do
        case "$p" in
            *[*?]*)
                hit=$(find "$HARNESS_ROOT" -type f -iname "$p" \
                      -not -path '*/node_modules/*' -not -path '*/.git/*' \
                      -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.harness/*' 2>/dev/null \
                      | sed "s#^$HARNESS_ROOT/##" | LC_ALL=C sort | head -1 || true)
                ;;
            *)
                if [ -f "$HARNESS_ROOT/$p" ]; then hit="$p"; else hit=""; fi
                ;;
        esac
        if [ -n "$hit" ]; then echo "$hit"; return; fi
    done
    echo ""
}

SRS_CANDIDATES=$(yaml_list "srs_candidates"); [ -n "$SRS_CANDIDATES" ] || SRS_CANDIDATES=$'SRS*.md\nsrs*.md\n*requirements*.md'
SPEC_CANDIDATES=$(yaml_list "spec_candidates"); [ -n "$SPEC_CANDIDATES" ] || SPEC_CANDIDATES=$'*spec*.md\nSPEC*.md\nopenapi*.y*ml'
IFS=$'\n' read -r -d '' -a SRS_ARR < <(printf '%s\0' "$SRS_CANDIDATES") || true
IFS=$'\n' read -r -d '' -a SPEC_ARR < <(printf '%s\0' "$SPEC_CANDIDATES") || true
SRS=$(find_first "${SRS_ARR[@]}")
SPEC=$(find_first "${SPEC_ARR[@]}")

STACK=()
[ -f "$HARNESS_ROOT/package.json" ] && STACK+=("node")
{ [ -f "$HARNESS_ROOT/requirements.txt" ] || [ -f "$HARNESS_ROOT/pyproject.toml" ]; } && STACK+=("python")
[ -f "$HARNESS_ROOT/go.mod" ] && STACK+=("go")
[ -f "$HARNESS_ROOT/pom.xml" ] && STACK+=("java")
[ -f "$HARNESS_ROOT/Cargo.toml" ] && STACK+=("rust")
[ -f "$HARNESS_ROOT/composer.json" ] && STACK+=("php")
[ ${#STACK[@]} -eq 0 ] && STACK+=("unknown")
# de-dup
STACK=($(printf '%s\n' "${STACK[@]}" | awk '!seen[$0]++'))

ARTIFACTS=()
add_artifact() {
    local v="$1" e
    [ -n "$v" ] || return 0
    # `[ ... ] && return` would make the loop's last status non-zero and trip set -e.
    for e in ${ARTIFACTS[@]+"${ARTIFACTS[@]}"}; do
        if [ "$e" = "$v" ]; then return 0; fi
    done
    ARTIFACTS+=("$v")
}
# A glob match that is a directory contributes itself; a match that is a FILE
# contributes its parent dir -- that is what makes "*/__init__.py" name the
# Python package on layouts whose source dir is not called "src".
resolve_dirs() {
    local g="$1" m d
    ( cd "$HARNESS_ROOT" 2>/dev/null || exit 0
      for m in $g; do
          [ -e "$m" ] || continue
          if [ -d "$m" ]; then
              printf '%s\n' "${m%/}"
          else
              d=$(dirname "$m"); [ "$d" = "." ] || printf '%s\n' "$d"
          fi
      done ) | LC_ALL=C sort -u
}
ART_GLOBS=$(yaml_list "artifact_globs"); [ -n "$ART_GLOBS" ] || ART_GLOBS=$'docs\ntests\ncontracts\n.harness'
SRC_GLOBS=$(yaml_list "source_globs");   [ -n "$SRC_GLOBS" ]  || SRC_GLOBS=$'src\napp\nlib\n*/__init__.py'
while IFS= read -r g; do [ -n "$g" ] || continue; while IFS= read -r hit; do add_artifact "$hit"; done < <(resolve_dirs "$g"); done <<< "$SRC_GLOBS"
while IFS= read -r g; do [ -n "$g" ] || continue; while IFS= read -r hit; do add_artifact "$hit"; done < <(resolve_dirs "$g"); done <<< "$ART_GLOBS"

join_q() { local out=""; for x in "$@"; do out="$out\"$x\", "; done; echo "${out%, }"; }

mkdir -p "$(dirname "$STORE")"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
    echo "# pipeline-context pointer store (H1) -- auto-built by harness-context-build."
    echo "# Sub-agents read this to discover inputs WITHOUT re-scanning the repo."
    echo "generated_at: \"$NOW\""
    echo "srs_path: \"$SRS\""
    echo "spec_path: \"$SPEC\""
    echo "tech_stack: [$(join_q "${STACK[@]}")]"
    echo "artifact_paths: [$(join_q "${ARTIFACTS[@]}")]"
} > "$STORE"

echo "[context] built pipeline-context.yaml (stack=$(IFS=/; echo "${STACK[*]}"); artifacts=${#ARTIFACTS[@]})"

# H1 RAG-lite — (re)build the retrieval index over context sources (best-effort).
RAG="$HARNESS_ROOT/.harness/scripts/lib/harness_rag.py"
if [ -f "$RAG" ] && command -v python3 >/dev/null 2>&1; then
    HARNESS_ROOT="$HARNESS_ROOT" python3 "$RAG" index --root "$HARNESS_ROOT" || true
fi
exit 0
