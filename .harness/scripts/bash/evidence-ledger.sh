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
while [ $# -gt 0 ]; do
    case "$1" in
        --entry-json) ENTRY_JSON_ARG="$2"; shift 2 ;;
        --entry-file) ENTRY_FILE_ARG="$2"; shift 2 ;;
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
        tail -1 "$CHAIN_FILE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('entry_hash','GENESIS'))" 2>/dev/null || echo "GENESIS"
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
    print(f'LEDGER INTACT — {len(lines)} entries verified')
else:
    print('LEDGER COMPROMISED', file=sys.stderr)
    sys.exit(2)
" 2>&1
        ;;
    *)
        echo "Usage: $0 {init|append|verify}"
        exit 1
        ;;
esac
