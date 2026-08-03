#!/usr/bin/env bash
# Push local .harness telemetry to the Control Portal (bash parity of
# push-telemetry.ps1). For checkouts the Portal backend cannot read directly.
# Config: .harness/portal-sync.json {portal_url, project_id}; key via env
# HARNESS_PORTAL_INGEST_KEY or git-ignored .harness/portal-sync.key (C5).
# Idempotent: server-side dedupe makes re-pushing the same files safe.
set -euo pipefail

HARNESS_ROOT="${HARNESS_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
CONFIG="$HARNESS_ROOT/.harness/portal-sync.json"

if [ ! -f "$CONFIG" ]; then
    echo "[push-telemetry] No .harness/portal-sync.json -- push sync not configured, skipping."
    exit 0
fi

KEY="${HARNESS_PORTAL_INGEST_KEY:-}"
if [ -z "$KEY" ] && [ -f "$HARNESS_ROOT/.harness/portal-sync.key" ]; then
    KEY="$(tr -d '[:space:]' < "$HARNESS_ROOT/.harness/portal-sync.key")"
fi
if [ -z "$KEY" ]; then
    echo "[push-telemetry] No ingest key (env HARNESS_PORTAL_INGEST_KEY or .harness/portal-sync.key)" >&2
    exit 0
fi

HARNESS_PUSH_KEY="$KEY" HARNESS_PUSH_ROOT="$HARNESS_ROOT" HARNESS_PUSH_CONFIG="$CONFIG" python3 - <<'PY' || true
import json, os, re, sys, glob, urllib.request, urllib.error
from datetime import datetime, timezone

root = os.environ["HARNESS_PUSH_ROOT"]
cfg = json.load(open(os.environ["HARNESS_PUSH_CONFIG"], encoding="utf-8-sig"))
url = cfg.get("portal_url", "").rstrip("/")
pid = cfg.get("project_id", "")
if not url or not pid:
    print("[push-telemetry] portal-sync.json missing portal_url/project_id", file=sys.stderr)
    sys.exit(0)

# Self-healing resample: rebuild agentops.log from this project's Claude Code
# transcripts (case-insensitive drive letter, recursive incl. subagents) so
# usage is captured even if the SessionEnd sampler never ran.
#
# Read-merge-write, NOT blind overwrite: agentops-sampler.sh (SubagentStop
# hook) already stamps active_account/active_member onto rows it writes live.
# This block only sees raw transcripts, which carry neither field, so a plain
# "w" rebuild from scratch would erase every stamp on every push -- and for a
# plain (non-delegating) main session, this resample is the ONLY writer, since
# the sampler is wired solely to SubagentStop. Fix: read whatever agentops.log
# already has, keyed the same way (session_id:agent_name); a transcript-derived
# row only replaces an existing one when it has STRICTLY MORE tokens (genuine
# "resumed, more happened" case), and only a replaced/new row gets re-stamped
# with the CURRENT pointer/env values -- coarser than a live per-turn stamp,
# but far better than silently blank. Anything the transcript scan doesn't
# touch at all (rotated out of the transcript window) survives untouched.
def _load_existing(fp):
    # Keyed identically to the transcript scan below so the merge lines up.
    # Unparseable lines are skipped, never allowed to crash the resample.
    d = {}
    try:
        with open(fp, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try: rec = json.loads(line)
                except Exception: continue
                sid = rec.get("session_id"); agent = rec.get("agent_name")
                if not sid or not agent: continue
                d[sid + ":" + agent] = rec
    except OSError:
        pass
    return d

def _active_account(home):
    # Same global per-machine pointer harness-switch-account writes; absent or
    # unreadable -> "" so an old client (no such file yet) sees the same blank
    # it always has.
    try:
        p = os.path.join(home, ".harness", "active-account.local.json")
        with open(p, encoding="utf-8-sig") as f:
            return str((json.load(f) or {}).get("active_account") or "")
    except Exception:
        return ""

def _resample():
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or os.path.expanduser("~")
    proot = os.path.join(home, ".claude", "projects")
    if not os.path.isdir(proot):
        return
    e = re.sub(r"[:\\/._]", "-", root).lower()
    dirs = [d for d in glob.glob(os.path.join(proot, "*")) if os.path.isdir(d)
            and (os.path.basename(d).lower() == e or os.path.basename(d).lower().startswith(e + "-"))]
    def samp(fp):
        tin = tout = tools = 0; model = ""; first = last = None; by = {}
        try:
            with open(fp, encoding="utf-8-sig") as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    try: rec = json.loads(line)
                    except Exception: continue
                    ts = rec.get("timestamp")
                    if ts: first = first or ts; last = ts
                    if rec.get("type") != "assistant": continue
                    msg = rec.get("message") or {}
                    if not isinstance(msg, dict): continue
                    u = msg.get("usage"); mid = msg.get("id")
                    if u and mid: by[mid] = u
                    m = msg.get("model")
                    if m and m != "<synthetic>": model = m
                    for b in (msg.get("content") or []):
                        if isinstance(b, dict) and b.get("type") == "tool_use": tools += 1
        except OSError:
            return None
        for u in by.values():
            tin += int(u.get("input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0)
            tout += int(u.get("output_tokens") or 0)
        if tin == 0 and tout == 0 and not model: return None
        return {"tin": tin, "tout": tout, "tools": tools, "model": model or "unknown", "first": first, "last": last}
    entries = {}
    for d in dirs:
        for fp in glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True):
            sid = os.path.splitext(os.path.basename(fp))[0]
            r = samp(fp)
            if not r: continue
            agent = "subagent" if (os.sep + "subagents" + os.sep) in fp else "main"
            k = sid + ":" + agent
            prev = entries.get(k)
            if prev and (prev["tin"] + prev["tout"]) >= (r["tin"] + r["tout"]): continue
            r["sid"] = sid; r["agent"] = agent; entries[k] = r
    if not entries:
        return
    tel = os.path.join(root, ".harness", "telemetry"); os.makedirs(tel, exist_ok=True)
    log_path = os.path.join(tel, "agentops.log")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    active_account = _active_account(home)
    active_member = os.environ.get("HARNESS_USER") or ""
    # Union base: every row the current file already has, so anything the
    # transcript scan above has no key for is preserved untouched.
    merged = _load_existing(log_path)
    for r in entries.values():
        k = r["sid"] + ":" + r["agent"]
        old_rec = merged.get(k)
        new_tokens = r["tin"] + r["tout"]
        if old_rec is not None:
            old_tokens = int(old_rec.get("tokens_in") or 0) + int(old_rec.get("tokens_out") or 0)
            if old_tokens >= new_tokens:
                continue  # existing row (and its active_account/active_member) survives untouched
        cost = r["tin"] / 1e6 * 3.0 + r["tout"] / 1e6 * 15.0
        merged[k] = {
            "timestamp": now, "agent_name": r["agent"], "model": r["model"], "session_id": r["sid"],
            "status": "completed", "tokens_in": r["tin"], "tokens_out": r["tout"],
            "total_tokens": r["tin"] + r["tout"], "estimated_cost_usd": round(cost, 6),
            "latency_ms": 0, "tool_calls": r["tools"],
            "start_time": r["first"] or now, "end_time": r["last"] or now,
            "active_account": active_account, "active_member": active_member,
        }
    with open(log_path, "w", encoding="utf-8") as out:
        for rec in merged.values():
            out.write(json.dumps(rec, separators=(",", ":")) + "\n")

try:
    _resample()
except Exception:
    pass

def read(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return f.read()
    except OSError:
        return ""

body = {
    "agentops": read(os.path.join(root, ".harness", "telemetry", "agentops.log")),
    "chain_jsonl": read(os.path.join(root, ".harness", "ledger", "chain.jsonl")),
    "security_events": read(os.path.join(root, ".harness", "telemetry", "security-events.jsonl")),
    "tool_calls": read(os.path.join(root, ".harness", "telemetry", "tool-calls.log")),
    "test_reports": read(os.path.join(root, ".harness", "telemetry", "test-reports.jsonl")),
    "member_email": str(cfg.get("member_email") or ""),
    "buglist": read(os.path.join(root, "buglist.md")),
}
# H3 — evidence bundles -> prompt_scores
import glob as _glob
bundles = {}
bdir = os.path.join(root, ".harness", "ledger", "bundles")
if os.path.isdir(bdir):
    for bf in _glob.glob(os.path.join(bdir, "*.json")):
        try:
            bundles[os.path.basename(bf)] = open(bf, encoding="utf-8-sig").read()
        except OSError:
            pass
body["bundles"] = bundles
# H1 — source<->doc traceability scan (this repo), via the bundle-installed lib
body["source_doc_map"] = ""
ds = os.path.join(root, ".harness", "scripts", "lib", "harness_docscan.py")
if os.path.isfile(ds):
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("harness_docscan", ds)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        body["source_doc_map"] = json.dumps(mod.scan(root))
    except Exception:
        pass
# CASAN evidence snapshot — a push-based project has no server checkout, so
# harness_root_ref is empty and every machine-checked criterion reads not-met.
# Ship the raw files those checks read; scoring stays server-side, so this can
# only cost the project points, never inflate them.
body["casan_files"] = {}
body["casan_manifest"] = []
body["casan_skipped"] = []
snaplib = os.path.join(root, ".harness", "scripts", "lib", "harness_casan_snapshot.py")
if os.path.isfile(snaplib):
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("harness_casan_snapshot", snaplib)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        snap = mod.snapshot(root)
        body["casan_files"] = snap.get("files") or {}
        body["casan_manifest"] = snap.get("manifest") or []
        # The third state. Without it the server cannot tell a control we
        # deliberately did not send from one the project does not have, and it
        # scores both as not-met — a false RED is as bad as a false GREEN.
        body["casan_skipped"] = snap.get("skipped") or []
        withheld = sum(1 for e in body["casan_skipped"] if e.get("withheld"))
        print("[push-telemetry] CASAN snapshot: %d files, %d manifest entries, %d skipped (%d withheld)" % (
            len(body["casan_files"]), len(body["casan_manifest"]),
            len(body["casan_skipped"]), withheld))
    except Exception:
        pass

if not any(body.values()):
    print("[push-telemetry] Nothing to push (no telemetry files yet).")
    sys.exit(0)

req = urllib.request.Request(
    f"{url}/api/ingest/{pid}",
    data=json.dumps(body).encode("utf-8"),
    headers={
        "Content-Type": "application/json; charset=utf-8",
        "X-Ingest-Key": os.environ["HARNESS_PUSH_KEY"],
        # Cloudflare's bot rules 403 the default Python-urllib UA; identify
        # ourselves as the harness client instead.
        "User-Agent": "harness-push-telemetry/1.0",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        r = json.loads(resp.read())
    print("[push-telemetry] OK: actions=%s incidents=%s usage=%s tool_calls=%s" % (
        r.get("action_log_ingested", 0), r.get("security_incidents_ingested", 0),
        r.get("usage_events_ingested", 0), r.get("tool_calls_ingested", 0)))
except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
    # Never fail the calling hook; the next push retries everything (dedupe).
    # Print the server's BODY, not just the status line: an HTTPError carries the
    # response, and a 422 names the offending field there. Without this a
    # rejected push looks like an empty, undiagnosable error (parity with the
    # PowerShell client, which reads it off the exception's response stream).
    detail = ""
    if isinstance(e, urllib.error.HTTPError):
        try:
            detail = e.read().decode("utf-8", "replace")[:800]
        except Exception:
            detail = ""
    if detail:
        print(f"[push-telemetry] Push failed: {e}\n  server said: {detail}", file=sys.stderr)
    else:
        print(f"[push-telemetry] Push failed: {e}", file=sys.stderr)
PY
exit 0
