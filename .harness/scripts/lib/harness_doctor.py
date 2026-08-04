#!/usr/bin/env python3
"""harness doctor — local self-check for a project's evidence pipeline.

Answers, without querying the Portal DB, the question four consuming projects had
no way to answer except by watching their score fall: *why is my evidence not
being recorded?* Prints an OK / WARN / FAIL line per check and a one-line verdict.

Read-only. Exit code is always 0 by default (it is a diagnostic, not a gate);
pass --strict to exit 1 when any FAIL is present, for use in CI.

Shared core so the PowerShell and bash wrappers emit identical output (C7): the
two harness-doctor.* scripts are thin shells that call this.
"""
import json
import os
import re
import sys
import time

OK, WARN, FAIL, INFO = "OK", "WARN", "FAIL", "INFO"


def _age(path):
    """Human age of a file's mtime, or None if absent."""
    try:
        dt = time.time() - os.path.getmtime(path)
    except OSError:
        return None
    if dt < 90:
        return "%ds" % int(dt)
    if dt < 5400:
        return "%dm" % int(dt / 60)
    if dt < 129600:
        return "%dh" % int(dt / 3600)
    return "%dd" % int(dt / 86400)


def _last_line(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            back = min(size, 4096)
            f.seek(size - back)
            tail = f.read().decode("utf-8", "replace").strip().splitlines()
            return tail[-1] if tail else ""
    except OSError:
        return ""


def _read(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return f.read()
    except OSError:
        return ""


def run(root):
    """Yield (status, label, detail) tuples."""
    H = os.path.join(root, ".harness")
    tel = os.path.join(H, "telemetry")

    # 1) Ledger — genesis present and chain non-trivial?
    chain = os.path.join(H, "ledger", "chain.jsonl")
    if not os.path.exists(chain):
        yield FAIL, "ledger", "chain.jsonl missing — no genesis. Run a session (session-start writes it) or `evidence-ledger init`."
    else:
        try:
            lines = [l for l in open(chain, encoding="utf-8-sig") if l.strip()]
            first = json.loads(lines[0]) if lines else {}
            genesis = first.get("prev_hash") == "GENESIS"
            n = len(lines)
            if not genesis:
                yield WARN, "ledger", "%d entries but first is not GENESIS — chain cannot prove it is intact from the start." % n
            elif n <= 1:
                yield WARN, "ledger", "genesis only (1 entry) — no side-effect has been recorded yet."
            else:
                yield OK, "ledger", "%d entries, genesis present, last write %s ago." % (n, _age(chain))
        except Exception as e:
            yield FAIL, "ledger", "chain.jsonl unreadable: %s" % e

    # 2) Telemetry files — present and fresh?
    for name, label in [("tool-calls.log", "audit (tool-calls)"),
                        ("agentops.log", "token/cost (agentops)"),
                        ("test-reports.jsonl", "test reports")]:
        p = os.path.join(tel, name)
        a = _age(p)
        if a is None:
            yield WARN, label, "%s absent — no evidence of this kind has been produced." % name
        else:
            yield OK, label, "%s, last write %s ago." % (name, a)

    # 3) hook-errors.log — the W1 escape hatch. Entries here explain a dead pipeline.
    hook_err = os.path.join(tel, "hook-errors.log")
    if os.path.exists(hook_err):
        errs = [l for l in open(hook_err, encoding="utf-8-sig") if l.strip()]
        if errs:
            last = errs[-1]
            try:
                j = json.loads(last)
                last = "%s: %s" % (j.get("hook", "?"), j.get("error", "")[:80])
            except Exception:
                last = last[:90]
            yield WARN, "hook errors", "%d recorded — most recent: %s" % (len(errs), last)
        else:
            yield OK, "hook errors", "none recorded."
    else:
        yield OK, "hook errors", "none recorded."

    # 4) pipeline-context — exists, and tech_stack not the poison value "unknown"?
    ctx = os.path.join(H, "context", "pipeline-context.yaml")
    txt = _read(ctx)
    if not txt:
        yield FAIL, "context (H1)", "pipeline-context.yaml missing — H1 criteria read it. session-start builds it."
    else:
        # Line-scan rather than a YAML dep: doctor must run with stdlib only.
        m = re.search(r'tech_stack:\s*\[?\s*"?unknown"?\s*\]?', txt)
        has_srs = bool(re.search(r'srs_path:\s*\S', txt))
        if m:
            yield FAIL, "context (H1)", "tech_stack is [\"unknown\"] — this fails H1-4 permanently and silently. Fill it in."
        elif not has_srs:
            yield WARN, "context (H1)", "present but srs_path not set — H1 partial."
        else:
            yield OK, "context (H1)", "present, tech_stack set, srs_path set."

    # 5) casan-policies — the file most scoring criteria read.
    pol = os.path.join(H, "control", "casan-policies.yaml")
    if not _read(pol):
        yield FAIL, "policies", "casan-policies.yaml missing — H3/H5/H6/H7 criteria read it."
    else:
        yield OK, "policies", "casan-policies.yaml present."

    # 6) Hook wiring — is anything actually invoking the harness on tool use?
    settings = _read(os.path.join(root, ".claude", "settings.json"))
    if not settings:
        yield WARN, "hook wiring", ".claude/settings.json not found — hooks may not be wired for Claude Code."
    else:
        wired = [h for h in ("PostToolUse", "SessionStart", "SessionEnd") if h in settings]
        if "PostToolUse" in wired:
            yield OK, "hook wiring", "settings.json wires %s." % ", ".join(wired)
        else:
            yield FAIL, "hook wiring", "settings.json has no PostToolUse hook — audit/ledger never fire."

    # 7) Portal push freshness — did telemetry actually leave the machine?
    cur = os.path.join(tel, ".push-cursor.json")
    a = _age(cur)
    if a is None:
        yield WARN, "portal push", "no push cursor — telemetry may never have been pushed to the Portal."
    else:
        yield OK, "portal push", "last push %s ago (cursor present)." % a

    # 8) Agent Pack readiness (v1.6.0) — is the project's test runner configured?
    ac = os.path.join(H, "control", "agent-config.yaml")
    if not _read(ac):
        yield INFO, "agent pack", "agent-config.yaml not set — impact-review/run-affected-tests will fall back to full suite."
    else:
        yield OK, "agent pack", "agent-config.yaml present (review->fix->test runner configured)."


def main(argv):
    # Consuming projects run on Windows consoles whose default codepage (cp932,
    # cp1252, ...) cannot encode the em-dash/arrow characters below and would
    # crash the whole diagnostic mid-print. Force UTF-8 and never die on a glyph.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    root = "."
    strict = False
    for a in argv[1:]:
        if a == "--strict":
            strict = True
        elif a in ("-h", "--help"):
            print("usage: harness_doctor.py [ROOT] [--strict]"); return 0
        elif not a.startswith("-"):
            root = a
    root = os.path.abspath(root)

    print("harness doctor  --  %s" % root)
    print("=" * 60)
    counts = {OK: 0, WARN: 0, FAIL: 0, INFO: 0}
    icon = {OK: "[ OK ]", WARN: "[WARN]", FAIL: "[FAIL]", INFO: "[INFO]"}
    for status, label, detail in run(root):
        counts[status] += 1
        print("%s %-20s %s" % (icon[status], label, detail))
    print("=" * 60)
    print("%d OK, %d WARN, %d FAIL" % (counts[OK], counts[WARN], counts[FAIL]))
    if counts[FAIL]:
        print("verdict: evidence pipeline has FAILING checks -- fix the [FAIL] lines above.")
    elif counts[WARN]:
        print("verdict: pipeline works but some evidence is thin (see [WARN]).")
    else:
        print("verdict: evidence pipeline healthy.")
    return 1 if (strict and counts[FAIL]) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
