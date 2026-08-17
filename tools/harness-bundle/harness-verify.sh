#!/usr/bin/env bash
# Harness "doctor" (POSIX parity of harness-verify.ps1). Verifies a project has
# the governance bundle applied correctly: reads .harness/.bundle-manifest.json,
# checks every file present + hash-matches, checks .claude/settings.json uses the
# current hook schema and its guard script exists.
# Exit 0 = healthy; 1 = problems. "modified" files are reported, not fatal.
#
#   ./harness-verify.sh --target <project>   # default: current dir
set -euo pipefail

TARGET="."
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ -d "$TARGET" ]] || { echo "target not found: $TARGET" >&2; exit 2; }
PY="$(command -v python3 || command -v python || true)"
[[ -n "$PY" ]] || { echo "python3 required" >&2; exit 3; }

"$PY" - "$TARGET" <<'PY'
import json, hashlib, os, sys
target = os.path.abspath(sys.argv[1])
print("== Harness verify: %s" % target)

receipt = os.path.join(target, ".harness", ".bundle-manifest.json")
if not os.path.exists(receipt):
    print("  [X] NOT INSTALLED -- no receipt (.harness/.bundle-manifest.json).")
    print("      Install first: install.sh --bundle <x.bundle.json> --target %s" % target)
    sys.exit(1)
r = json.load(open(receipt, encoding="utf-8"))
print("  bundle: %s v%s  installed_at=%s" % (r["name"], r["version"], r.get("installed_at")))

ok = 0; missing = []; modified = []
for f in r["files"]:
    dest = os.path.join(target, *f["path"].split("/"))
    if not os.path.exists(dest): missing.append(f["path"]); continue
    cur = hashlib.sha256(open(dest, "rb").read()).hexdigest()
    (modified if cur != f["sha256"] else [None]).append(f["path"]) if cur != f["sha256"] else None
    if cur == f["sha256"]: ok += 1
print("  files: %d OK / %d modified / %d missing  (of %d)" % (ok, len(modified), len(missing), len(r["files"])))
for m in missing: print("     [MISSING] %s" % m)
for m in modified: print("     [modified] %s" % m)

hooks_wired = False; hook_msg = ""
sp = os.path.join(target, ".claude", "settings.json")
if not os.path.exists(sp):
    hook_msg = "no .claude/settings.json"
else:
    s = json.load(open(sp, encoding="utf-8"))
    pre = s.get("hooks", {}).get("PreToolUse")
    if pre is None:
        hook_msg = "no PreToolUse hook"
    elif isinstance(pre, str):
        hook_msg = "OLD bare-path format -> hooks will NOT fire (re-install settings.json)"
    else:
        cmd = pre[0]["hooks"][0]
        arg = [a for a in cmd.get("args", []) if not a.startswith("-")]
        rel = (arg[-1] if arg else "").replace("${CLAUDE_PROJECT_DIR}", ".").lstrip("./")
        script = os.path.join(target, *rel.split("/"))
        exists = os.path.exists(script)
        hooks_wired = exists
        hook_msg = "array schema OK; interpreter='%s'; guard script %s" % (
            cmd.get("command"), "found" if exists else "MISSING: " + rel)
print("  hooks: %s%s" % ("[OK] " if hooks_wired else "[!] ", hook_msg))

pol = os.path.join(target, ".harness", "uninstall-policy.json")
if os.path.exists(pol):
    p = json.load(open(pol, encoding="utf-8")); print("  uninstall lock: LOCKED (pm='%s')" % p.get("pm"))
else:
    print("  uninstall lock: none")

healthy = (not missing) and hooks_wired
if healthy:
    extra = (" (with %d locally-modified file(s) -- fine if intentional)" % len(modified)) if modified else ""
    print("== RESULT: APPLIED OK" + extra); sys.exit(0)
print("== RESULT: NOT FULLY APPLIED")
if missing: print("   -> %d file(s) missing: re-run install.sh" % len(missing))
if not hooks_wired: print("   -> hooks not wired: rm .claude/settings.json then re-run install (or install.sh --force)")
sys.exit(1)
PY
