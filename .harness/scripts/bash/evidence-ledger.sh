#!/usr/bin/env bash
# Hash-chain ledger (bash parity) — append-only immutable audit trail (H5).
set -euo pipefail

HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
LEDGER_DIR="$HARNESS_ROOT/.harness/ledger"
CHAIN_FILE="$LEDGER_DIR/chain.jsonl"
BUNDLE_DIR="$LEDGER_DIR/bundles"
mkdir -p "$BUNDLE_DIR"

COMMAND="${1:-append}"
shift || true

ENTRY_JSON_ARG=""
ENTRY_FILE_ARG=""
REASON_ARG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --entry-json) ENTRY_JSON_ARG="$2"; shift 2 ;;
        --entry-file) ENTRY_FILE_ARG="$2"; shift 2 ;;
        --reason) REASON_ARG="$2"; shift 2 ;;
        *) shift ;;
    esac
done

# Resolve entry input without ever blocking on an unredirected terminal (PIPE-1).
# Prints to stdout; callers must pipe the result into python (never string-interpolate
# untrusted JSON into a `python -c` literal — that is a code-injection hole).
read_entry_input() {
    if [ -n "$ENTRY_JSON_ARG" ]; then
        printf '%s' "$ENTRY_JSON_ARG"
    elif [ -n "$ENTRY_FILE_ARG" ]; then
        cat "$ENTRY_FILE_ARG"
    elif [ ! -t 0 ]; then
        cat
    else
        echo "[evidence-ledger] No input provided — pass --entry-json, --entry-file, or pipe JSON via stdin" >&2
        exit 1
    fi
}

hash_entry() {
    echo -n "$1" | sha256sum | cut -d' ' -f1
}

get_last_hash() {
    if [ -f "$CHAIN_FILE" ]; then
        # UNREADABLE, not GENESIS, when the last entry cannot be parsed:
        # "GENESIS" claims the chain STARTS here, silently orphaning everything
        # above the bad line -- and the chain would then verify as intact while
        # having lost its history. An unreadable predecessor is recorded as
        # exactly that, so `verify` reports the break instead of hiding it.
        # (PS parity: Get-LastEntry/$PrevHash in evidence-ledger.ps1.)
        tail -1 "$CHAIN_FILE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('entry_hash') or 'UNREADABLE')" 2>/dev/null || echo "UNREADABLE"
    else
        echo "GENESIS"
    fi
}

get_next_index() {
    if [ -f "$CHAIN_FILE" ]; then
        wc -l < "$CHAIN_FILE" | tr -d ' '
    else
        echo "0"
    fi
}

case "$COMMAND" in
    init)
        TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        cat > "$CHAIN_FILE" << JSONL
{"index":0,"prev_hash":"GENESIS","entry_hash":"","timestamp":"$TIMESTAMP","actor":{"agent":"harness","user":"system","session_id":"genesis","role":"system"},"action":{"type":"config_change","tool":"harness-init","description":"Genesis block"},"decision":{"result":"allow","reason":"System initialization","risk_level":"none"},"payload_ref":"","signature":""}
JSONL
        # Compute hash of the entry (without entry_hash field)
        ENTRY_NO_HASH=$(python3 -c "
import json
with open('$CHAIN_FILE') as f:
    e = json.load(f)
e['entry_hash'] = ''
print(json.dumps(e, sort_keys=True, separators=(',',':')))
")
        HASH=$(hash_entry "$ENTRY_NO_HASH")
        # Rewrite with computed hash
        python3 -c "
import json
with open('$CHAIN_FILE') as f:
    e = json.load(f)
e['entry_hash'] = '$HASH'
with open('$CHAIN_FILE', 'w') as f:
    json.dump(e, f, separators=(',',':'))
    f.write('\n')
"
        echo "[evidence-ledger] Genesis block created at index 0, hash=$HASH"
        ;;
    append)
        INPUT_JSON=$(read_entry_input)
        if [ -z "$INPUT_JSON" ]; then
            echo "[evidence-ledger] No input" >&2
            exit 1
        fi
        NEXT_INDEX=$(get_next_index)
        PREV_HASH=$(get_last_hash)
        TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        # Entry JSON is piped to python's stdin, never string-interpolated into
        # the script literal — untrusted content in a `python -c` string would
        # otherwise be a code-injection hole (e.g. an entry crafted to break out
        # of the ''' literal).
        printf '%s' "$INPUT_JSON" | NEXT_INDEX="$NEXT_INDEX" PREV_HASH="$PREV_HASH" TIMESTAMP="$TIMESTAMP" CHAIN_FILE="$CHAIN_FILE" python3 -c "
import json, sys, os, hashlib

entry = json.load(sys.stdin)
next_idx = int(os.environ['NEXT_INDEX'])
prev_hash = os.environ['PREV_HASH']
ts = os.environ['TIMESTAMP']
chain_file = os.environ['CHAIN_FILE']

new_entry = {
    'index': next_idx,
    'prev_hash': prev_hash,
    'entry_hash': '',
    'timestamp': ts,
    'actor': entry.get('actor', {'agent':'unknown','user':'unknown','session_id':'','role':''}),
    'action': entry.get('action', {'type':'tool_call','tool':'','description':'','input_hash':'','output_hash':''}),
    'decision': entry.get('decision', {'result':'allow','reason':'','risk_level':'none'}),
    'payload_ref': entry.get('payload_ref',''),
    'signature': entry.get('signature','')
}
canonical = dict(new_entry)
canonical['entry_hash'] = ''
h = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(',',':')).encode()).hexdigest()
new_entry['entry_hash'] = h
with open(chain_file, 'a') as f:
    json.dump(new_entry, f, separators=(',',':'))
    f.write('\n')
print(f'Appended entry {next_idx}, hash={h}, prev={prev_hash}')
"
        ;;
    verify)
        python3 -c "
import json, hashlib, sys
with open('$CHAIN_FILE') as f:
    lines = [l.strip() for l in f if l.strip()]
prev = 'GENESIS'
valid = True
for i, line in enumerate(lines):
    e = json.loads(line)
    if e['prev_hash'] != prev:
        print(f'CHAIN BREAK at {i}: prev_hash mismatch', file=sys.stderr)
        valid = False
    stored = e['entry_hash']
    e['entry_hash'] = ''
    computed = hashlib.sha256(json.dumps(e, sort_keys=True, separators=(',',':')).encode()).hexdigest()
    if computed != stored:
        print(f'TAMPER at {i}: hash mismatch', file=sys.stderr)
        valid = False
    prev = stored
if valid:
    # ASCII '--', not an em dash: this prints to whatever console the operator
    # has, and cp932/cp936 consoles crash python on U+2014 (a consuming project's report).
    print(f'LEDGER INTACT -- {len(lines)} entries verified')
else:
    print('LEDGER COMPROMISED', file=sys.stderr)
    sys.exit(2)
" 2>&1
        ;;
    seal)
        # Close the segment around bad history instead of editing it (PS parity:
        # evidence-ledger.ps1 "seal"). One final entry saying why, archive the
        # file untouched as chain-NNN.jsonl, fresh chain.jsonl whose genesis
        # records the archive's name + head hash for cross-file continuity.
        if [ ! -f "$CHAIN_FILE" ]; then
            echo "[evidence-ledger] Nothing to seal -- no chain.jsonl"
            exit 0
        fi
        SEAL_REASON="${REASON_ARG:-segment sealed (no reason given)}"
        NEXT_INDEX=$(get_next_index)
        PREV_HASH=$(get_last_hash)
        TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        SEAL_HASH=$(NEXT_INDEX="$NEXT_INDEX" PREV_HASH="$PREV_HASH" TIMESTAMP="$TIMESTAMP" \
            CHAIN_FILE="$CHAIN_FILE" SEAL_REASON="$SEAL_REASON" \
            HOOK_USER="${HARNESS_USER:-}" HOOK_SESSION="${HARNESS_SESSION_ID:-}" python3 -c "
import json, os, hashlib
e = {
    'index': int(os.environ['NEXT_INDEX']),
    'prev_hash': os.environ['PREV_HASH'],
    'entry_hash': '',
    'timestamp': os.environ['TIMESTAMP'],
    'actor': {'agent':'harness','user':os.environ.get('HOOK_USER',''),'session_id':os.environ.get('HOOK_SESSION',''),'role':'system'},
    'action': {'type':'seal','tool':'evidence-ledger','description':os.environ['SEAL_REASON']},
    'decision': {'result':'allow','reason':'segment sealed','risk_level':'none'},
    'payload_ref': '', 'signature': ''
}
c = dict(e); c['entry_hash'] = ''
h = hashlib.sha256(json.dumps(c, sort_keys=True, separators=(',',':')).encode()).hexdigest()
e['entry_hash'] = h
with open(os.environ['CHAIN_FILE'], 'a') as f:
    json.dump(e, f, separators=(',',':')); f.write('\n')
print(h)
")
        # Next free archive number -- never overwrite an existing archive.
        N=1
        for f in "$LEDGER_DIR"/chain-*.jsonl; do
            [ -e "$f" ] || continue
            num=$(basename "$f" | sed -n 's/^chain-\([0-9]*\)\.jsonl$/\1/p')
            [ -n "$num" ] && [ "$((10#$num))" -ge "$N" ] && N=$((10#$num + 1))
        done
        ARCHIVE_NAME=$(printf 'chain-%03d.jsonl' "$N")
        # Stage the new genesis BEFORE the rename so the no-chain window is one
        # mv, not a build-then-write; a hook appending into that window would
        # otherwise start its own unlinked chain.
        STAGED="$LEDGER_DIR/.chain.genesis.tmp"
        TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ) ARCHIVE_NAME="$ARCHIVE_NAME" SEAL_HASH="$SEAL_HASH" STAGED="$STAGED" python3 -c "
import json, os, hashlib
g = {
    'index': 0, 'prev_hash': 'GENESIS', 'entry_hash': '',
    'timestamp': os.environ['TIMESTAMP'],
    'actor': {'agent':'harness','user':'system','session_id':'seal','role':'system'},
    'action': {'type':'config_change','tool':'evidence-ledger','description':'Genesis block -- segment continues from ' + os.environ['ARCHIVE_NAME']},
    'decision': {'result':'allow','reason':'segment rotation','risk_level':'none'},
    'payload_ref': '', 'signature': '',
    'prev_segment': os.environ['ARCHIVE_NAME'],
    'prev_segment_head': os.environ['SEAL_HASH'],
}
c = dict(g); c['entry_hash'] = ''
g['entry_hash'] = hashlib.sha256(json.dumps(c, sort_keys=True, separators=(',',':')).encode()).hexdigest()
with open(os.environ['STAGED'], 'w') as f:
    json.dump(g, f, separators=(',',':')); f.write('\n')
"
        mv "$CHAIN_FILE" "$LEDGER_DIR/$ARCHIVE_NAME"
        mv "$STAGED" "$CHAIN_FILE"
        echo "[evidence-ledger] Sealed segment -> $ARCHIVE_NAME (head $SEAL_HASH)"
        echo "[evidence-ledger] New segment started; genesis links prev_segment_head for cross-file continuity"
        ;;
    bundle)
        # Generate an evidence bundle for a change (PS parity: evidence-ledger.ps1
        # "bundle"). Field-for-field the same shape and the same
        # truthy-input-or-default fallback per field, so a bundle written on Linux
        # and one written on Windows agree byte-for-byte given the same input.
        INPUT_JSON=$(read_entry_input)
        if [ -z "$INPUT_JSON" ]; then
            echo "[evidence-ledger] No input provided for bundle" >&2
            exit 1
        fi
        TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        SESSION_ID="${HARNESS_SESSION_ID:-}"
        BUNDLE_JSON=$(printf '%s' "$INPUT_JSON" | TIMESTAMP="$TIMESTAMP" SESSION_ID="$SESSION_ID" python3 -c "
import json, os, sys, uuid

inp = json.load(sys.stdin)
if not isinstance(inp, dict):
    inp = {}

def sect(name):
    v = inp.get(name)
    return v if isinstance(v, dict) else {}

rv = sect('review_verdict')

# Same idiom as the PS bundle command: an explicitly-sent value wins, a
# missing/blank/zero one falls back to the field's default. Kept identical
# on purpose (C7) rather than 'fixed' here -- see the tracked follow-up on
# the PS side's truthy-vs-null-check gap for booleans.
def sv(d, k, default):
    v = d.get(k)
    return v if v not in (None, '', 0, False, []) else default

change_id = inp.get('change_id') or ('change-' + os.environ['TIMESTAMP'].replace('-', '').replace(':', '').replace('T', '').replace('Z', ''))

# H3-2 depth: pass the judge's per-dimension rubric through, same filter
# hard-gate.ps1 already applies when READING review_verdict (no hard-gate.sh
# exists yet -- a separate C7 gap) -- only numeric values, dimension omitted
# (not zero-filled) when the judge did not score it. rubric_scores itself is
# always present, {} when the judge gave nothing.
raw_rubric = rv.get('rubric_scores')
rubric = {}
if isinstance(raw_rubric, dict):
    for k, v in raw_rubric.items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            rubric[k] = float(v)

bundle = {
    'bundle_id': str(uuid.uuid4()),
    'change_id': change_id,
    'created_at': os.environ['TIMESTAMP'],
    'created_by': {
        'agent': sv(sect('created_by'), 'agent', 'unknown'),
        'user': sv(sect('created_by'), 'user', 'unknown'),
        'session_id': sv(sect('created_by'), 'session_id', os.environ.get('SESSION_ID', '')),
    },
    'requirement_trace': {
        'spec_ref': sv(sect('requirement_trace'), 'spec_ref', ''),
        'requirement_ids': sv(sect('requirement_trace'), 'requirement_ids', []),
    },
    'design_impact': {
        'description': sv(sect('design_impact'), 'description', ''),
        'affected_components': sv(sect('design_impact'), 'affected_components', []),
        'design_doc_ref': sv(sect('design_impact'), 'design_doc_ref', ''),
    },
    'code_diff': {
        'files_changed': sv(sect('code_diff'), 'files_changed', []),
        'diff_ref': sv(sect('code_diff'), 'diff_ref', ''),
        'diff_hash': sv(sect('code_diff'), 'diff_hash', ''),
    },
    'test_report': {
        'passed': sv(sect('test_report'), 'passed', 0),
        'failed': sv(sect('test_report'), 'failed', 0),
        'skipped': sv(sect('test_report'), 'skipped', 0),
        'coverage_percent': sv(sect('test_report'), 'coverage_percent', 0),
        'report_ref': sv(sect('test_report'), 'report_ref', ''),
    },
    'security_scan': {
        'scanner': sv(sect('security_scan'), 'scanner', ''),
        'findings_count': sv(sect('security_scan'), 'findings_count', 0),
        'high_critical_count': sv(sect('security_scan'), 'high_critical_count', 0),
        'passed': sv(sect('security_scan'), 'passed', True),
        'report_ref': sv(sect('security_scan'), 'report_ref', ''),
    },
    'review_verdict': {
        'verdict': sv(rv, 'verdict', 'PENDING'),
        'score': sv(rv, 'score', 0),
        'reviewer_agent': sv(rv, 'reviewer_agent', ''),
        'feedback': sv(rv, 'feedback', ''),
        'rubric_scores': rubric,
    },
    'approval_record': {
        'required': sv(sect('approval_record'), 'required', False),
        'approved_by': sv(sect('approval_record'), 'approved_by', ''),
        'approved_at': sv(sect('approval_record'), 'approved_at', ''),
        'approval_ref': sv(sect('approval_record'), 'approval_ref', ''),
    },
    'cost_telemetry': {
        'tokens_used': sv(sect('cost_telemetry'), 'tokens_used', 0),
        'estimated_cost_usd': sv(sect('cost_telemetry'), 'estimated_cost_usd', 0),
        'duration_seconds': sv(sect('cost_telemetry'), 'duration_seconds', 0),
    },
}
print(json.dumps(bundle, indent=2))
")
        # Re-derive change_id/bundle_id from the JSON itself (not from separate
        # shell variables) so the filename and the printed IDs can never disagree
        # with what was actually written.
        CHANGE_ID=$(echo "$BUNDLE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['change_id'])" 2>/dev/null)
        BUNDLE_FILE="$BUNDLE_DIR/$CHANGE_ID-bundle.json"
        printf '%s\n' "$BUNDLE_JSON" > "$BUNDLE_FILE"
        BUNDLE_ID=$(echo "$BUNDLE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['bundle_id'])" 2>/dev/null)
        echo "[evidence-ledger] Evidence bundle created: $BUNDLE_FILE"
        echo "[evidence-ledger] Bundle ID: $BUNDLE_ID"
        echo "[evidence-ledger] Change ID: $CHANGE_ID"
        printf '%s\n' "$BUNDLE_JSON"
        ;;
    *)
        echo "Usage: $0 {init|append|verify|seal|bundle}"
        exit 1
        ;;
esac
