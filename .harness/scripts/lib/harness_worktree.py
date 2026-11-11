#!/usr/bin/env python3
"""C16 "Worktree budget" -- shared core for every worktree check.

At most `max_extra` git worktrees besides the main checkout (default 2). Each one
is a full copy of the source on disk, and a forgotten one is a second place the
truth lives (B-91: 92,196 files in .claude/worktrees hung the Portal sync for a
week). When the work in a worktree is done it is merged into `merge_target`,
pushed, and the worktree is removed -- `finish` does exactly that, never with
--force.

Callers (thin wrappers, so PowerShell and bash decide identically, C7):
  guard   PreToolUse (harness-runtime-guard): deny a call that would create a
          worktree when the budget is full. Reads the hook JSON on stdin and
          prints {"decision":"deny"|"allow","reason":...}.
  start   SessionStart: print a short note when over budget or a worktree is
          stale. Prints nothing when all is well (C14).
  stop    Stop: in a worktree whose work is committed, block ONCE per HEAD with
          "merge it now: finish". Prints a block decision or nothing.
  status  Human (or --json) list of worktrees with their state.
  finish  Merge the worktree's branch into merge_target, push, remove the
          worktree, delete the branch (git branch -d). Refuses on any doubt.
  post-checkout / install-git-hook
          The git-level detector for tools without hooks (Codex, a person):
          git runs post-checkout on `git worktree add`; it cannot abort the
          add, so it warns. install-git-hook writes that hook into the shared
          hooks dir unless one is already there.

Honest scope (C10): local, defense-in-depth. Claude Code's PreToolUse can deny
the creating call; nothing local can stop Codex or a person from running
`git worktree add` -- for them this is detection (post-checkout, SessionStart,
doctor). C13: the count comes from `git worktree list --porcelain`, the only
authority; any error resolves to "allow / stay silent" in a hook.

stdlib only (hooks run with whatever python is on PATH).
"""
import json
import os
import re
import subprocess
import sys
import time

# Never write __pycache__ next to the libs: inside a worktree that untracked
# folder makes `git status` dirty, and a dirty worktree is "still working" to
# the Stop hook -- in any project that does not gitignore __pycache__ the
# reminder would never fire (caught by CI on Linux, 11-11).
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_handoff as HH  # noqa: E402  (shared casan-policies block reader)

DEFAULTS = {
    "enabled": True,
    "max_extra": 2,
    "merge_target": "main",
    "push_after_merge": True,
    "remind_on_stop": True,
    "merged_idle_hours": 12,
    "stale_after_days": 3,
}

NULL_SHA = "0" * 40

# A shell command that creates a worktree: `git worktree add`, with any global
# options (-C <dir>, -c k=v, --git-dir=...) between `git` and `worktree`.
# Stops at a command separator so `git status; echo worktree add` does not match.
SHELL_CREATE = re.compile(r"\bgit(?:\.exe)?\b[^\n;&|]*?\bworktree\s+add\b", re.I)


# ---- config -----------------------------------------------------------------

def effective_config(root):
    cfg = dict(DEFAULTS)
    cfg.update({k: v for k, v in (HH.read_config(root, "worktrees") or {}).items() if v is not None})
    for k in ("max_extra", "merged_idle_hours", "stale_after_days"):
        try:
            cfg[k] = max(0, int(cfg[k]))
        except (TypeError, ValueError):
            cfg[k] = DEFAULTS[k]
    return cfg


# ---- git --------------------------------------------------------------------

def _git(cwd, *args, timeout=30):
    """(returncode, stdout, stderr) as text. Never raises for a git failure."""
    try:
        p = subprocess.run(("git", "-C", cwd) + args, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "", str(e)
    return (p.returncode, p.stdout.decode("utf-8", "replace").strip(),
            p.stderr.decode("utf-8", "replace").strip())


def _same(a, b):
    na = os.path.normcase(os.path.normpath(os.path.abspath(a)))
    nb = os.path.normcase(os.path.normpath(os.path.abspath(b)))
    return na == nb


def _within(path, parent):
    p = os.path.normcase(os.path.normpath(os.path.abspath(path)))
    q = os.path.normcase(os.path.normpath(os.path.abspath(parent)))
    return p == q or p.startswith(q.rstrip(os.sep) + os.sep)


def list_worktrees(root):
    """All worktrees of the repo containing `root`, main first, or None."""
    rc, out, _ = _git(root, "worktree", "list", "--porcelain")
    if rc != 0:
        return None
    res, cur = [], None
    for line in out.splitlines() + [""]:
        if not line.strip():
            if cur:
                res.append(cur)
            cur = None
            continue
        key, _, val = line.partition(" ")
        if key == "worktree":
            cur = {"path": os.path.normpath(val), "head": "", "branch": "",
                   "detached": False, "bare": False, "locked": False, "prunable": False}
        elif cur is None:
            continue
        elif key == "HEAD":
            cur["head"] = val
        elif key == "branch":
            cur["branch"] = val[len("refs/heads/"):] if val.startswith("refs/heads/") else val
        elif key in ("detached", "bare", "locked", "prunable"):
            cur[key] = True
    return res


def extras(wts):
    """The worktrees that count against the budget: every one but the main
    checkout, minus `prunable` ones (their directory is already gone)."""
    return [w for w in (wts or [])[1:] if not w["prunable"]]


def _target_ref(root, cfg):
    t = str(cfg.get("merge_target") or "main")
    rc, sha, _ = _git(root, "rev-parse", "--verify", "--quiet", "refs/heads/%s^{commit}" % t)
    return (t, sha) if rc == 0 and sha else (t, None)


def describe(root, w, cfg, now=None):
    """Adds: dirty, ahead, merged, idle_hours, state (active|merged|stale|unknown)."""
    now = now or time.time()
    d = dict(w)
    t, tsha = _target_ref(root, cfg)
    if not os.path.isdir(w["path"]):
        d.update(dirty=None, ahead=None, merged=None, idle_hours=None, state="unknown")
        return d
    # Last activity: the newer of HEAD's commit time and the worktree's index /
    # HEAD file (git touches them on add/commit/checkout). A fresh worktree has a
    # new index, so it is never "idle" on its first day. Read BEFORE `git status`,
    # which can rewrite the index -- and status runs with --no-optional-locks so
    # that merely looking never makes a worktree look busy.
    times = []
    rc, ct, _ = _git(w["path"], "log", "-1", "--format=%ct")
    if rc == 0 and ct.isdigit():
        times.append(int(ct))
    rc, gd, _ = _git(w["path"], "rev-parse", "--absolute-git-dir")
    if rc == 0 and gd:
        for f in ("index", "HEAD"):
            try:
                times.append(os.path.getmtime(os.path.join(gd, f)))
            except OSError:
                pass
    rc, st, _ = _git(w["path"], "--no-optional-locks", "status", "--porcelain")
    d["dirty"] = None if rc != 0 else bool(st)
    d["ahead"] = None
    d["merged"] = None
    if tsha and w["head"]:
        rc, n, _ = _git(root, "rev-list", "--count", "%s..%s" % (tsha, w["head"]))
        if rc == 0 and n.isdigit():
            d["ahead"] = int(n)
            d["merged"] = int(n) == 0
    d["idle_hours"] = round((now - max(times)) / 3600.0, 1) if times else None
    idle = d["idle_hours"]
    if d["merged"] and d["dirty"] is False and idle is not None and idle >= cfg["merged_idle_hours"]:
        d["state"] = "merged"      # done and merged, only the folder is left
    elif idle is not None and idle >= cfg["stale_after_days"] * 24:
        d["state"] = "stale"       # abandoned
    elif d["dirty"] is None or d["merged"] is None:
        d["state"] = "unknown"
    else:
        d["state"] = "active"
    return d


def _short(w):
    b = w.get("branch") or ("(detached %s)" % (w.get("head") or "")[:8])
    return "%s [%s]" % (w["path"], b)


def _finish_cmd(root, path=None):
    ps1 = os.path.join(root, ".harness", "scripts", "powershell", "harness-worktree.ps1")
    cmd = 'powershell -NoProfile -File "%s" finish' % ps1
    return cmd + (' -Path "%s"' % path if path else "")


# ---- guard (PreToolUse) -------------------------------------------------------

def creation_kind(payload):
    """What in this tool call would create a LOCAL worktree, or None."""
    tool = str(payload.get("tool_name") or payload.get("tool") or "")
    ti = payload.get("tool_input") or payload.get("input") or {}
    if not isinstance(ti, dict):
        ti = {}
    if tool == "EnterWorktree":
        # Entering an existing worktree by path creates nothing.
        return None if ti.get("path") else "EnterWorktree"
    if tool in ("Agent", "Task") and str(ti.get("isolation") or "").lower() == "worktree":
        return "%s(isolation: worktree)" % tool
    if tool.endswith("start_session") and ti.get("use_worktree") is True \
            and str(ti.get("target") or "local").lower() not in ("cloud", "ssh"):
        return "start_session(use_worktree: true)"
    cmd = ti.get("command") or ti.get("script") or ""
    if isinstance(cmd, str) and SHELL_CREATE.search(cmd):
        return "git worktree add"
    return None


def decide_guard(root, payload):
    kind = creation_kind(payload)
    if not kind:
        return {"decision": "allow"}
    cfg = effective_config(root)
    if cfg.get("enabled") is False:
        return {"decision": "allow", "reason": "worktrees.enabled: false"}
    wts = list_worktrees(root)
    if wts is None:
        return {"decision": "allow", "reason": "not a git repo / git unreadable"}
    ex = extras(wts)
    if len(ex) < cfg["max_extra"]:
        return {"decision": "allow"}
    main = wts[0]["path"]
    lines = []
    for w in ex:
        d = describe(root, w, cfg)
        s = d["state"]
        if d.get("ahead"):
            s += ", %d commit chua merge" % d["ahead"]
        if d.get("dirty"):
            s += ", co thay doi chua commit"
        lines.append("%s -> %s" % (_short(w), s))
    reason = (
        "C16 worktree budget: repo nay da co %d/%d worktree ngoai main - khong tao them (%s). "
        "Ket thuc mot worktree truoc: commit, roi `%s` (merge vao %s, push, xoa worktree + nhanh). "
        "Hoac lam viec ngay trong main %s. Dang co: %s"
        % (len(ex), cfg["max_extra"], kind, _finish_cmd(main, "<duong-dan-worktree>"),
           cfg["merge_target"], main, "; ".join(lines))
    )
    return {"decision": "deny", "reason": reason}


# ---- start / stop hooks -------------------------------------------------------

def report_lines(root, cfg=None):
    """Short findings for SessionStart / doctor: (over_budget, [line, ...])."""
    cfg = cfg or effective_config(root)
    wts = list_worktrees(root)
    if wts is None:
        return None
    ex = extras(wts)
    out = []
    over = len(ex) > cfg["max_extra"]
    for w in ex:
        d = describe(root, w, cfg)
        if d["state"] == "merged":
            out.append("%s da merge vao %s, khong dung %.0f gio -> xoa: %s"
                       % (_short(w), cfg["merge_target"], d["idle_hours"], _finish_cmd(wts[0]["path"], w["path"])))
        elif d["state"] == "stale":
            out.append("%s bo do %.0f ngay (%s commit chua merge%s)"
                       % (_short(w), d["idle_hours"] / 24.0, d.get("ahead"),
                          ", co thay doi chua commit" if d.get("dirty") else ""))
    return over, ex, out


def decide_start(root):
    cfg = effective_config(root)
    if cfg.get("enabled") is False:
        return ""
    r = report_lines(root, cfg)
    if not r:
        return ""
    over, ex, lines = r
    if not over and not lines:
        return ""
    head = "[harness C16] worktree: %d/%d ngoai main" % (len(ex), cfg["max_extra"])
    if over:
        head += " - VUOT MUC; ket thuc bot truoc khi tao moi"
    return "\n".join([head] + ["  - " + l for l in lines]) + "\n"


def decide_stop(root, payload):
    if payload.get("stop_hook_active"):
        return None
    cfg = effective_config(root)
    if cfg.get("enabled") is False or cfg.get("remind_on_stop") is False:
        return None
    rc, top, _ = _git(root, "rev-parse", "--show-toplevel")
    if rc != 0:
        return None
    wts = list_worktrees(root)
    if not wts or _same(top, wts[0]["path"]):
        return None  # in the main checkout: nothing to finish
    me = next((w for w in wts[1:] if _same(w["path"], top)), None)
    if me is None or me["detached"] or not me["branch"]:
        return None
    if me["branch"] == cfg["merge_target"]:
        return None
    d = describe(root, me, cfg)
    if d["dirty"] is None or d["ahead"] is None:
        return None  # cannot tell -> stay silent (C14)
    if d["dirty"]:
        return None  # mid-work: the reminder comes once the work is committed
    # Once per HEAD: a new commit earns a new reminder, the same one never twice.
    rc, gd, _ = _git(top, "rev-parse", "--absolute-git-dir")
    marker = os.path.join(gd, "harness-c16-reminded") if rc == 0 and gd else None
    if marker:
        try:
            with open(marker, encoding="utf-8") as f:
                if f.read().strip() == me["head"]:
                    return None
        except OSError:
            pass
        try:
            with open(marker, "w", encoding="utf-8") as f:
                f.write(me["head"])
        except OSError:
            pass
    if d["ahead"]:
        what = "nhanh %s co %d commit chua vao %s" % (me["branch"], d["ahead"], cfg["merge_target"])
    else:
        what = "nhanh %s da nam trong %s, chi con thu muc worktree" % (me["branch"], cfg["merge_target"])
    reason = (
        "C16 - ket thuc worktree / finish the worktree: %s. Neu cong viec trong worktree nay DA XONG, "
        "chay ngay `%s` (merge vao %s, push, xoa worktree, xoa nhanh bang -d; khong force) roi bao ket qua. "
        "Neu CHUA xong hoac dang cho nguoi dung duyet thi bo qua - nhac lai o commit sau."
        % (what, _finish_cmd(wts[0]["path"], top), cfg["merge_target"])
    )
    return {"decision": "block", "reason": reason}


# ---- finish -------------------------------------------------------------------

class Refuse(Exception):
    pass


def finish(root, path=None, no_push=False, log=print):
    """Merge -> push -> remove -> delete branch. Returns 0 done, 1 refused,
    3 merged+pushed but the folder could not be removed (in use)."""
    cfg = effective_config(root)
    target = str(cfg.get("merge_target") or "main")
    wts = list_worktrees(path or root)
    if wts is None:
        raise Refuse("khong doc duoc `git worktree list` tai %s" % (path or root))
    main = wts[0]["path"]
    if path:
        wt_path = path
    else:
        rc, wt_path, _ = _git(root, "rev-parse", "--show-toplevel")
        if rc != 0:
            raise Refuse("khong xac dinh duoc worktree hien tai")
    me = next((w for w in wts[1:] if _same(w["path"], wt_path)), None)
    if me is None:
        if _same(wt_path, main):
            raise Refuse("%s la checkout chinh, khong phai worktree - truyen -Path <worktree>" % main)
        raise Refuse("%s khong phai worktree cua repo nay" % wt_path)
    wt = me["path"]
    if me["prunable"] or not os.path.isdir(wt):
        _git(main, "worktree", "prune")
        raise Refuse("thu muc %s da mat; da chay `git worktree prune`" % wt)
    if me["detached"] or not me["branch"]:
        raise Refuse("%s dang detached HEAD - tao nhanh va commit truoc" % wt)
    branch = me["branch"]
    if branch == target:
        raise Refuse("worktree %s dang o chinh nhanh %s" % (wt, target))
    if me["locked"]:
        raise Refuse("worktree %s dang bi khoa (git worktree unlock neu chac chan)" % wt)

    log("[1/5] Kiem tra %s (nhanh %s) va checkout chinh %s" % (wt, branch, main))
    rc, st, _ = _git(wt, "status", "--porcelain")
    if rc != 0 or st:
        raise Refuse("worktree con thay doi chua commit - commit (hoac bo) truoc:\n%s" % st)
    rc, mbranch, _ = _git(main, "rev-parse", "--abbrev-ref", "HEAD")
    if rc != 0 or mbranch != target:
        raise Refuse("checkout chinh %s dang o '%s', khong phai '%s'" % (main, mbranch, target))
    rc, mst, _ = _git(main, "status", "--porcelain", "--untracked-files=no")
    if rc != 0 or mst:
        raise Refuse("checkout chinh %s co thay doi chua commit - xu ly truoc khi merge:\n%s" % (main, mst))

    rc, remote, _ = _git(main, "config", "--get", "branch.%s.remote" % target)
    remote = remote if rc == 0 and remote else ""
    if remote:
        log("[2/5] Cap nhat %s tu %s (ff-only)" % (target, remote))
        rc, _, err = _git(main, "pull", "--ff-only", "--quiet", remote, target, timeout=180)
        if rc != 0:
            raise Refuse("`git pull --ff-only %s %s` that bai - %s da re nhanh voi remote:\n%s"
                         % (remote, target, target, err))
    else:
        log("[2/5] %s khong co remote theo doi - bo qua pull/push" % target)

    log("[3/5] Merge %s vao %s" % (branch, target))
    rc, out, err = _git(main, "merge", "--no-edit", branch, timeout=180)
    if rc != 0:
        _git(main, "merge", "--abort")
        raise Refuse("merge %s -> %s xung dot / that bai, da `git merge --abort`. Giai quyet trong worktree "
                     "(merge %s vao %s, sua, commit) roi chay lai.\n%s" % (branch, target, target, branch, err or out))
    rc, n, _ = _git(main, "rev-list", "--count", "%s..%s" % (target, branch))
    if rc != 0 or n != "0":
        raise Refuse("sau merge, %s van con commit chua nam trong %s - dung lai" % (branch, target))

    if remote and not no_push and cfg.get("push_after_merge") is not False:
        log("[4/5] Push %s len %s" % (target, remote))
        rc, _, err = _git(main, "push", remote, target, timeout=300)
        if rc != 0:
            raise Refuse("push that bai (merge da nam o local %s; worktree CHUA xoa). Sua quyen push roi "
                         "chay lai lenh nay - merge se khong lap lai.\n%s" % (target, err))
    else:
        log("[4/5] Bo qua push")

    log("[5/5] Xoa worktree %s va nhanh %s" % (wt, branch))
    try:
        os.chdir(main)  # never stand inside the folder being removed
    except OSError:
        pass
    rc, _, err = _git(main, "worktree", "remove", wt, timeout=180)
    if rc != 0:
        log("CANH BAO: da merge%s, nhung khong xoa duoc thu muc worktree:\n  %s\n"
            "Thuong la do mot tien trinh (chinh phien AI dang chay trong do, editor, terminal) con giu thu muc. "
            "Dong phien/cua so do roi chay lai lenh nay; hoac archive phien trong Claude app."
            % ("" if not remote or no_push else " + push", err))
        return 3
    rc, _, err = _git(main, "branch", "-d", branch)
    if rc != 0:
        log("CANH BAO: worktree da xoa nhung `git branch -d %s` that bai: %s" % (branch, err))
    _git(main, "worktree", "prune")
    left = extras(list_worktrees(main) or [])
    log("XONG: %s da vao %s, worktree da xoa. Con %d/%d worktree ngoai main."
        % (branch, target, len(left), cfg["max_extra"]))
    return 0


# ---- status -----------------------------------------------------------------

def status(root, as_json=False):
    cfg = effective_config(root)
    wts = list_worktrees(root)
    if wts is None:
        print("khong phai git repo: %s" % root)
        return 1
    rows = [describe(root, w, cfg) for w in extras(wts)]
    if as_json:
        print(json.dumps({"main": wts[0]["path"], "max_extra": cfg["max_extra"],
                          "merge_target": cfg["merge_target"], "extras": rows}, ensure_ascii=False))
        return 0
    print("main: %s" % wts[0]["path"])
    print("worktree ngoai main: %d/%d" % (len(rows), cfg["max_extra"]))
    for d in rows:
        print("  %-8s %s  ahead=%s dirty=%s idle=%sh"
              % (d["state"], _short(d), d["ahead"], d["dirty"], d["idle_hours"]))
    return 0


# ---- git-level detector (Codex / a person) ------------------------------------

HOOK_MARK = "harness-c16-post-checkout"
HOOK_BODY = """#!/bin/sh
# %s -- written by harness-worktree install-git-hook (C16).
# git runs post-checkout after `git worktree add` (old ref = all zeros). It
# cannot undo the add; it warns when the worktree budget is exceeded.
[ "$1" = "%s" ] || exit 0
top="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
lib="$top/.harness/scripts/lib/harness_worktree.py"
[ -f "$lib" ] || exit 0
py="$(command -v python3 || command -v python)" || exit 0
"$py" "$lib" post-checkout "$top" >&2 || true
exit 0
""" % (HOOK_MARK, NULL_SHA)


def post_checkout(root):
    cfg = effective_config(root)
    if cfg.get("enabled") is False:
        return 0
    wts = list_worktrees(root)
    if not wts or _same(root, wts[0]["path"]):
        return 0  # a clone or a checkout in main, not a new worktree
    ex = extras(wts)
    if len(ex) > cfg["max_extra"]:
        sys.stderr.write(
            "\n[harness C16] CANH BAO: repo nay gio co %d worktree ngoai main (toi da %d).\n"
            "  Ket thuc mot cai: %s\n  Danh sach: %s\n\n"
            % (len(ex), cfg["max_extra"], _finish_cmd(wts[0]["path"], "<duong-dan-worktree>"),
               "; ".join(_short(w) for w in ex)))
    return 0


def install_git_hook(root):
    rc, hooks, _ = _git(root, "rev-parse", "--git-path", "hooks")
    if rc != 0:
        print("khong phai git repo: %s" % root)
        return 1
    rc, hp, _ = _git(root, "config", "--get", "core.hooksPath")
    if not os.path.isabs(hooks):
        hooks = os.path.join(root, hooks)
    target = os.path.join(hooks, "post-checkout")
    if os.path.exists(target):
        with open(target, encoding="utf-8", errors="replace") as f:
            if HOOK_MARK in f.read():
                print("da co: %s" % target)
                return 0
        print("BO QUA: %s da ton tai (hook cua du an/cong cu khac). Them dong sau vao cuoi hook do:\n"
              '  [ "$1" = "%s" ] && python "$(git rev-parse --show-toplevel)/.harness/scripts/lib/'
              'harness_worktree.py" post-checkout "$(git rev-parse --show-toplevel)" >&2' % (target, NULL_SHA))
        return 0
    os.makedirs(hooks, exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        f.write(HOOK_BODY)
    try:
        os.chmod(target, 0o755)
    except OSError:
        pass
    print("da cai: %s%s" % (target, " (core.hooksPath=%s)" % hp if hp else ""))
    return 0


# ---- entry ------------------------------------------------------------------

def _payload():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", "replace")
        p = json.loads(raw) if raw.strip() else {}
        return p if isinstance(p, dict) else {}
    except Exception:
        return {}


def _log_error(root, msg):
    try:
        log = os.path.join(root, ".harness", "telemetry", "hook-errors.log")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps({"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                "hook": "worktree", "error": msg[:200]}) + "\n")
    except Exception:
        pass


USAGE = ("usage: harness_worktree.py guard|start|stop|post-checkout ROOT  (hook modes)\n"
         "       harness_worktree.py status ROOT [--json]\n"
         "       harness_worktree.py finish ROOT [--path WORKTREE] [--no-push]\n"
         "       harness_worktree.py install-git-hook ROOT")


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(USAGE)
        return 0
    mode = argv[1]
    rest = argv[2:]
    root = os.path.abspath(rest[0]) if rest and not rest[0].startswith("-") else os.getcwd()
    opts = rest[1:] if rest and not rest[0].startswith("-") else rest

    if mode in ("guard", "start", "stop"):
        # Hooks: never raise, never block on an error (fail-open, C10/C14).
        try:
            if mode == "guard":
                sys.stdout.write(json.dumps(decide_guard(root, _payload())) + "\n")
            elif mode == "start":
                sys.stdout.write(decide_start(root))
            else:
                out = decide_stop(root, _payload())
                if out:
                    sys.stdout.write(json.dumps(out) + "\n")
        except Exception as e:
            _log_error(root, "%s %s: %s" % (mode, type(e).__name__, e))
            if mode == "guard":
                sys.stdout.write(json.dumps({"decision": "allow", "reason": "error"}) + "\n")
        return 0
    if mode == "post-checkout":
        try:
            return post_checkout(root)
        except Exception:
            return 0
    if mode == "status":
        return status(root, as_json="--json" in opts)
    if mode == "install-git-hook":
        return install_git_hook(root)
    if mode == "finish":
        path, no_push, i = None, False, 0
        while i < len(opts):
            if opts[i] == "--path" and i + 1 < len(opts):
                path = os.path.abspath(opts[i + 1])
                i += 1
            elif opts[i] == "--no-push":
                no_push = True
            i += 1
        try:
            return finish(root, path=path, no_push=no_push)
        except Refuse as e:
            print("TU CHOI: %s" % e)
            return 1
    print(USAGE)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
