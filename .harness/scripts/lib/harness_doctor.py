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
import hashlib
import json
import os
import re
import subprocess
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


def _git(root, *args):
    """Run a git command, returning stdout or "" — never raising."""
    try:
        out = subprocess.run(("git", "-C", root) + args, capture_output=True,
                             text=True, timeout=20)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def _default_branch(root):
    """(branch, source) -- the repo's default branch and HOW it was established.

    Returns ("", "none") when it cannot be established honestly.

    Mirrors install.ps1's Get-DefaultBranch, and for the same reason:
    refs/remotes/*/HEAD is a LOCAL CACHE written at clone time and can be stale
    (one repo's pointed at a feature branch while its real default was main).
    Ask the server first; reject any namespaced name as a feature branch; and
    return "" rather than guess -- a wrong default here would report a healthy
    gate as dead, and that false alarm costs more than the missing check.

    C13 is why the SOURCE comes back with the value. An inferred value that
    travels without its provenance cannot be second-guessed downstream: the
    caller sees `main` and has no way to know whether the server said so or
    whether a three-year-old local cache did. The four sources below are ordered
    by trustworthiness, and callers are expected to treat the cached and guessed
    ones as weaker evidence rather than as facts.
    """
    def plausible(b):
        return b and "/" not in b and b != "HEAD"

    remotes = [r for r in _git(root, "remote").splitlines() if r.strip()]

    # 1. The server itself. The only source that cannot be stale.
    for r in remotes:
        m = re.search(r"ref:\s+refs/heads/(\S+)\s+HEAD",
                      _git(root, "ls-remote", "--symref", r, "HEAD"))
        if m and plausible(m.group(1)):
            return m.group(1), "remote"

    # 2. The local cache of (1), written at clone time and never refreshed.
    for r in remotes:
        ref = _git(root, "symbolic-ref", "--quiet", "refs/remotes/%s/HEAD" % r)
        b = ref.replace("refs/remotes/%s/" % r, "")
        if plausible(b):
            return b, "cache"

    # 3. A conventional name that merely EXISTS on a remote. Weak: a repo can
    #    have both main and master with the wrong one first in this list.
    for cand in ("main", "master", "develop", "trunk"):
        for r in remotes:
            if _git(root, "rev-parse", "--verify", "--quiet",
                    "refs/remotes/%s/%s" % (r, cand)):
                return cand, "convention"

    # 4. Whatever this working copy happens to be sitting on. This is not
    #    evidence of anything -- it is the state of one developer's checkout --
    #    and it is exactly the source that produced a dead gate once already.
    b = _git(root, "rev-parse", "--abbrev-ref", "HEAD")
    if plausible(b):
        return b, "checkout"
    return "", "none"


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
    #
    # C14: this log is the only thing standing between "the pipeline died" and
    # "nobody noticed", so a false entry in it is a P0 defect, not untidiness.
    # Before v1.6.2 it logged every SUCCESSFUL ledger append as a failure --
    # `& script.ps1` leaves $LASTEXITCODE unset, evidence-ledger exited its
    # switch via `break`, and `$null -ne 0` is TRUE -- producing ~250 fake
    # errors in one repo. A log that cries wolf on every success trains everyone
    # to skip it, which costs exactly the one moment it was built for. So known
    # false-positive signatures are counted SEPARATELY and reported as damage to
    # the log rather than folded in with real errors.
    KNOWN_FALSE_POSITIVES = [
        # "exited" followed by two spaces: the exit code interpolated to empty.
        # A genuine failure has a number there, so this cannot match a real one.
        ("ledger append exited  for", "pre-1.6.2 bug logged SUCCESSFUL ledger appends as failures"),
    ]
    hook_err = os.path.join(tel, "hook-errors.log")
    if os.path.exists(hook_err):
        errs = [l for l in open(hook_err, encoding="utf-8-sig") if l.strip()]
        fake, real = [], []
        for line in errs:
            if any(sig in line for sig, _ in KNOWN_FALSE_POSITIVES):
                fake.append(line)
            else:
                real.append(line)
        if fake:
            why = next(w for sig, w in KNOWN_FALSE_POSITIVES if sig in fake[0])
            yield FAIL, "log integrity (C14)", (
                "%d of %d lines in hook-errors.log are KNOWN FALSE POSITIVES (%s). "
                "A diagnostic log that reports success as failure gets ignored, and it "
                "is the only warning of a dead pipeline. Prune with "
                "tools/harness-bundle/fix-fleet-evidence.ps1 (it keeps genuine errors)."
                % (len(fake), len(errs), why))
        else:
            yield OK, "log integrity (C14)", "no known false-positive signature in hook-errors.log."
        if real:
            last = real[-1]
            try:
                j = json.loads(last)
                last = "%s: %s" % (j.get("hook", "?"), j.get("error", "")[:80])
            except Exception:
                last = last[:90]
            yield WARN, "hook errors", "%d genuine error(s) recorded — most recent: %s" % (len(real), last)
        else:
            yield OK, "hook errors", "none recorded."
    else:
        yield OK, "log integrity (C14)", "no hook-errors.log yet."
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
    #
    # The cursor is written by push-telemetry.* running INSIDE this project. It
    # is not the only way telemetry reaches the Portal: a central sync can post
    # each project's files directly, and that pusher writes nothing here.
    #
    # The first version of this check said "no push cursor -- telemetry may
    # never have been pushed", which was FALSE for ten of eleven projects: they
    # are pushed every fifteen minutes by exactly such a sync. Ten false alarms
    # from one line, in the diagnostic whose whole job is to be believed.
    #
    # So the absent-cursor case says what is actually knowable from here, and
    # says it as INFO -- "cannot verify from this machine" is the C12-compliant
    # answer, and it is not a warning about the project.
    cur = os.path.join(tel, ".push-cursor.json")
    sync_cfg = os.path.join(H, "portal-sync.json")
    a = _age(cur)
    if a is not None:
        yield OK, "portal push", "last local push %s ago (cursor present)." % a
    elif not os.path.exists(sync_cfg):
        yield INFO, "portal push", "portal-sync.json absent — this project is not wired to a Portal, so there is nothing to push."
    else:
        yield INFO, "portal push", (
            "Portal sync is configured but no LOCAL push cursor exists. That is expected when a "
            "central sync posts this project's telemetry instead of push-telemetry running here — "
            "that pusher leaves no trace in this directory, so whether a push happened cannot be "
            "verified from this machine. Check the project's Fleet Health row in the Portal.")

    # 8) CI gates — do they exist, and would they ever FIRE?
    #
    # A workflow whose trigger names a branch this repo does not use installs
    # cleanly, sits in .github/, and never runs. Three such gates were created
    # three different ways in one session, each looking perfectly healthy: a
    # hardcoded `main` in a `master` repo, a repair script that read only
    # refs/remotes/ORIGIN/HEAD, and an installer that took the checked-out
    # feature branch. None produced an error anywhere. A dead gate is worse than
    # an absent one -- absence is visible, death reads as coverage -- so this
    # check exists to make that specific failure loud.
    wf = os.path.join(root, ".github", "workflows")
    harness_wf = [f for f in ("tests.yml", "harness-gate.yml")
                  if os.path.isfile(os.path.join(wf, f))]
    if not harness_wf:
        yield INFO, "ci gates", "no harness workflows installed (run the installer with -WithCiGates to add them)."
    else:
        # Does the workflow even PARSE?
        #
        # The branch check below asks whether a valid workflow would fire on the
        # right branch. It cannot see the case one project actually hit: the
        # YAML was malformed (a block-scalar line indented level with its `run:`
        # key), so GitHub Actions never ran the workflow at all. Nothing was
        # red, because nothing ran. The file sits there looking like a gate.
        #
        # stdlib has no YAML parser, so this is a structural check, not a full
        # one: it verifies the keys a workflow must have are present at column
        # zero and that no line under a `run:` block scalar is indented less
        # than the block. That is exactly the shape that broke, and a check that
        # catches the observed failure beats a perfect one that does not exist.
        broken = []
        for f in harness_wf:
            txt = _read(os.path.join(wf, f))
            if not txt:
                continue
            lines = txt.split("\n")
            if not re.search(r"^on:\s*$|^on:\s*\S", txt, re.M) or not re.search(r"^jobs:\s*$", txt, re.M):
                broken.append("%s: missing a top-level `on:` or `jobs:` key" % f)
                continue
            for i, line in enumerate(lines):
                # `- run: |` is as common as `run: |`, and matching only the
                # second missed the very shape this check exists for.
                m = re.match(r"^(\s*(?:-\s+)?)run:\s*\|", line)
                if not m:
                    continue
                # The column where `run:` itself starts, not the leading
                # whitespace: under `- run: |` the key sits two columns right of
                # the dash, and continuation lines must clear THAT.
                key_col = len(m.group(1))
                for j in range(i + 1, len(lines)):
                    nxt = lines[j]
                    if not nxt.strip():
                        continue
                    if len(nxt) - len(nxt.lstrip()) <= key_col:
                        # A sibling key or the next list item ends the block
                        # legitimately. Anything else at or left of the key is
                        # the malformed case.
                        if not re.match(r"^\s*[-\w]+:", nxt) and not nxt.lstrip().startswith("- "):
                            broken.append("%s line %d: a block-scalar line is indented level with its `run:` — "
                                          "GitHub rejects the file and the workflow never runs" % (f, j + 1))
                        break
        if broken:
            yield FAIL, "ci workflow syntax", (
                "workflow file(s) will not parse, so GitHub never runs them and nothing ever turns "
                "red: %s" % "; ".join(broken[:3]))
        else:
            yield OK, "ci workflow syntax", "%s parse as workflows." % ", ".join(harness_wf)

        default, source = _default_branch(root)
        dead, live = [], []
        for f in harness_wf:
            trigs = set(re.findall(r"^\s*branches:\s*\[([^\]]+)\]",
                                   _read(os.path.join(wf, f)), re.M))
            names = {b.strip().strip('"\'') for t in trigs for b in t.split(",")}
            if not names:
                continue
            if default and default not in names:
                dead.append("%s -> [%s]" % (f, ", ".join(sorted(names))))
            else:
                live.append(f)
        # C13: the verdict carries the provenance of the value it rests on.
        # `main (per the remote)` and `main (per a local cache)` are different
        # claims, and only the reader can decide whether the weaker one is good
        # enough -- which they cannot do if the check hides where it looked.
        WHENCE = {
            "remote": "asked the remote",
            "cache": "LOCAL CACHE refs/remotes/*/HEAD, written at clone time and never refreshed",
            "convention": "guessed from a conventional branch name that exists on a remote",
            "checkout": "taken from this working copy's current branch -- not evidence of the repo's default",
        }
        whence = WHENCE.get(source, source)
        if dead:
            yield FAIL, "ci gates", (
                "workflow triggers do not include this repo's default branch '%s' (%s): %s. "
                "These are installed but will NEVER run." % (default, whence, "; ".join(dead)))
        elif not default:
            yield WARN, "ci gates", "%s present, but the default branch could not be resolved to verify the trigger." % ", ".join(harness_wf)
        elif source in ("convention", "checkout"):
            # Matching a branch we only GUESSED proves nothing. Reporting OK here
            # would be the dead-gate bug wearing a green badge for a fourth time.
            yield WARN, "ci gates", (
                "%s trigger on '%s', which matches -- but that branch was %s, so the match "
                "is unverified. Run `git remote set-head <remote> -a` (or fetch) and re-run."
                % (", ".join(live), default, whence))
        else:
            yield OK, "ci gates", "%s present, triggering on '%s' (%s)." % (
                ", ".join(live), default, whence)

    # 9) C12 — does each gate have evidence it actually RAN?
    #
    # Every other check here asks whether a gate is *installed and would fire*.
    # That is not the same question, and the gap between them is where this
    # project has been burned repeatedly: three dead CI gates in one session,
    # each installed correctly, each silent, each reading as coverage. A gate
    # with no execution trace must be reported as UNPROVEN, never as passing --
    # "we have no evidence it ran" and "it ran and passed" are opposite claims.
    #
    # Deliberately does not invent evidence it cannot see. CI runs happen on a
    # server; nothing on this machine can prove one fired, so that gate is
    # reported as locally unverifiable rather than quietly assumed good. Saying
    # "I cannot check this from here" is the C12-compliant answer; saying OK
    # would be the exact failure the rule exists to stop.
    proven, unproven = [], []

    # Hooks prove themselves by what they write: a ledger longer than genesis
    # means the PostToolUse hook ran and the guard let a call through.
    chain_lines = 0
    if os.path.exists(chain):
        try:
            chain_lines = sum(1 for l in open(chain, encoding="utf-8-sig") if l.strip())
        except OSError:
            chain_lines = 0
    if chain_lines > 1:
        proven.append("hooks+guard (%d ledger entries)" % chain_lines)
    else:
        unproven.append("hooks+guard (ledger has no side-effect entry — the hook may never have fired)")

    # Eval suites prove themselves through their own reports.
    reports = os.path.join(tel, "test-reports.jsonl")
    suites_seen = set()
    if os.path.exists(reports):
        try:
            for line in open(reports, encoding="utf-8-sig"):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                # The writer emits `suite_name`; `suite` is accepted because an
                # older writer used it and a report we cannot name reads as a
                # suite that never ran -- i.e. this check would report a healthy
                # project's gates as unproven. Verified against the real file
                # rather than assumed: the first version of this check looked
                # only for `suite`, matched nothing, and confidently declared
                # three green suites unproven.
                suites_seen.add(rec.get("suite_name") or rec.get("suite") or "")
        except OSError:
            pass
    for suite in ("policy-ci", "red-team", "golden"):
        if suite in suites_seen:
            proven.append("eval:%s" % suite)
        else:
            unproven.append("eval:%s (no report ever written)" % suite)

    if harness_wf:
        # Present and pointed at the right branch is the most this machine can
        # establish. Whether GitHub ever ran it is a server-side fact.
        unproven.append("ci (%s installed; a local check cannot see whether a run "
                        "ever happened — confirm on the repo's Actions tab)" % ", ".join(harness_wf))

    if not unproven:
        yield OK, "gate proof (C12)", "every gate has left execution evidence: %s." % "; ".join(proven)
    elif not proven:
        yield FAIL, "gate proof (C12)", (
            "NO gate has left any execution evidence. Nothing here is protecting "
            "anything yet: %s" % "; ".join(unproven))
    else:
        yield WARN, "gate proof (C12)", (
            "proven: %s || UNPROVEN (absence of evidence, not evidence of "
            "health): %s" % ("; ".join(proven), "; ".join(unproven)))

    # 10) C3 — is every side-effect-capable tool registered?
    #
    # Deny-by-default only means anything if the registry says which tools have
    # side effects. An entry missing side_effect/risk_level is not a neutral
    # gap: the guard has nothing to match on, so the tool passes.
    reg = os.path.join(H, "control", "tool-registry.json")
    reg_txt = _read(reg)
    if not reg_txt:
        yield WARN, "tool registry (C3)", "tool-registry.json missing — nothing declares which tools have side effects."
    else:
        try:
            tools = (json.loads(reg_txt) or {}).get("tools") or {}
        except ValueError as e:
            tools = None
            yield FAIL, "tool registry (C3)", "tool-registry.json does not parse: %s" % e
        if tools is not None:
            if not tools:
                yield WARN, "tool registry (C3)", "tool-registry.json has no entries."
            else:
                bad = [k for k, v in tools.items()
                       if not isinstance(v, dict) or ("side_effect" not in v and "risk_level" not in v)]
                if bad:
                    yield FAIL, "tool registry (C3)", (
                        "%d of %d entries declare neither side_effect nor risk_level, so the guard has "
                        "nothing to match on and those tools pass unchecked: %s%s"
                        % (len(bad), len(tools), ", ".join(sorted(bad)[:5]),
                           " …" if len(bad) > 5 else ""))
                else:
                    yield OK, "tool registry (C3)", "%d tools registered, all declaring side_effect/risk_level." % len(tools)

    # 11) C7 — do the hooks behave the same on both shells?
    #
    # Deliberately NOT "every .ps1 has a .sh". Parity is BEHAVIOURAL: this repo
    # has seven PowerShell scripts with no twin, and most are right to have none
    # -- lib-security-log.ps1 exists because PowerShell needs a shared helper,
    # while the bash guard writes the same events inline. A file-for-file check
    # would raise seven false alarms, which is the cry-wolf failure C14 names.
    #
    # What actually breaks a Linux machine is a hook wired on one side and not
    # the other, so that is what is compared.
    def _hook_scripts(path):
        txt = _read(path)
        if not txt:
            return None
        # Basenames without extension: the two files name .ps1 and .sh copies of
        # the same script, and the stem is what makes them comparable.
        return {os.path.splitext(os.path.basename(m))[0]
                for m in re.findall(r'[\w.-]+\.(?:ps1|sh)', txt)}

    win = _hook_scripts(os.path.join(root, ".claude", "settings.json"))
    posix = _hook_scripts(os.path.join(root, ".claude", "settings.posix.json"))
    if win is None or posix is None:
        yield INFO, "shell parity (C7)", "one of settings.json / settings.posix.json is absent — cannot compare hook wiring."
    else:
        win_only = sorted(win - posix)
        posix_only = sorted(posix - win)
        if win_only or posix_only:
            parts = []
            if win_only:
                parts.append("wired on Windows only: " + ", ".join(win_only))
            if posix_only:
                parts.append("wired on POSIX only: " + ", ".join(posix_only))
            yield FAIL, "shell parity (C7)", (
                "hook wiring differs between shells, so this project is governed differently "
                "depending on the machine — %s" % "; ".join(parts))
        else:
            yield OK, "shell parity (C7)", "%d hook scripts wired identically on both shells." % len(win)

    # 13) R-4 — does every logged bug have a golden case guarding it?
    #
    # A bug that is fixed and then forgotten comes back. The golden set is the
    # only mechanism here that would notice, and eight of nine project reviews
    # said the same thing: it holds ~12 generic cases and nothing project-
    # specific. A generator can scaffold a case; only a check makes anyone fill
    # it in.
    #
    # A golden case claims a bug by naming it: {"id": ..., "bug": "B-04", ...}.
    #
    # Severity is read from config, NOT hardcoded to FAIL. A brand-new check
    # that turns every existing project red on day one is the cry-wolf failure
    # C14 names -- and it would land in the same week C12 started depending on
    # people actually reading this output.
    pol_txt = _read(pol)
    m = re.search(r'^\s*buglist_path\s*:\s*"?([^"#\r\n]+?)"?\s*(#.*)?$', pol_txt, re.M)
    buglist = os.path.join(root, (m.group(1).strip() if m else "buglist.md"))
    strict = bool(re.search(r'^\s*require_golden_per_bug\s*:\s*true\s*(#.*)?$', pol_txt, re.M))

    bug_ids = []
    if os.path.exists(buglist):
        # Ids come from the status table's anchor links, which is the one place
        # every entry appears exactly once. Scanning the whole document would
        # also match every cross-reference in a bug's own prose and inflate the
        # denominator -- a coverage number that drifts with how chatty the
        # write-ups are is worse than none.
        seen = set()
        for bid in re.findall(r'\[(B-\d+)\]\(#', _read(buglist)):
            if bid not in seen:
                seen.add(bid)
                bug_ids.append(bid)

    # 12) Is the bug log actually being kept?
    #
    # The constitution requires logging every bug found or introduced. Nothing
    # checked whether that happens, and a fleet scan showed why it matters: of
    # 194 bugs logged across twelve projects, ONE project held 143 of them and
    # seven projects held exactly one each. A project that has run for weeks and
    # logged one bug is not a clean project, it is an unkept log -- and every
    # screen reading that corpus silently treats the two as the same thing.
    #
    # Reported as UNPROVEN, never as a violation. A project genuinely can be
    # quiet, and from here the two are indistinguishable; saying "you broke the
    # rule" on that evidence would be the false alarm C14 forbids. The check
    # states both numbers and lets a human weigh them.
    #
    # The threshold is what "has clearly been used" means. 200 recorded
    # side-effects is roughly a week of ordinary work, low enough that a
    # genuinely new project never trips it.
    BUSY_LEDGER_ENTRIES = 200
    if bug_ids is not None and os.path.exists(buglist):
        if chain_lines >= BUSY_LEDGER_ENTRIES and len(bug_ids) <= 1:
            yield WARN, "bug log kept", (
                "%d side-effects recorded but only %d bug(s) logged in %s. Either this project "
                "is unusually clean or the logging rule is not being followed — from here those "
                "look identical, so this is unproven, not a violation. Whoever knows the project "
                "can settle it in a second."
                % (chain_lines, len(bug_ids), os.path.relpath(buglist, root)))
        else:
            yield OK, "bug log kept", "%d bug(s) logged against %d recorded side-effects." % (
                len(bug_ids), chain_lines)

    covered = set()
    gdir = os.path.join(root, ".harness", "eval", "golden")
    gm = re.search(r'^\s*golden_dataset_path\s*:\s*"?([^"#\r\n]+?)"?\s*(#.*)?$', pol_txt, re.M)
    if gm:
        gdir = os.path.join(root, gm.group(1).strip().replace("/", os.sep))
    if os.path.isdir(gdir):
        for fn in sorted(os.listdir(gdir)):
            if not fn.endswith(".jsonl"):
                continue
            try:
                for line in open(os.path.join(gdir, fn), encoding="utf-8-sig"):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        b = json.loads(line).get("bug")
                    except ValueError:
                        continue
                    if b:
                        covered.add(str(b).strip())
            except OSError:
                continue

    # Bugs the project has declared un-expressible as a golden case, with a
    # reason. Without this, the only way to clear the check on a parser or
    # encoding bug is to invent a case that tests nothing -- which is worse than
    # an uncovered bug, because it also lies.
    exempt = set()
    ex = re.search(r'^\s*golden_exempt_bugs\s*:\s*$(.*?)(?=^\s{0,2}\S|\Z)', pol_txt, re.M | re.S)
    if ex:
        exempt = set(re.findall(r'^\s+(B-\d+)\s*:', ex.group(1), re.M))

    # A high-water mark: only bugs from this number on are REQUIRED to carry a
    # case or an exemption.
    #
    # Without it the rule was retroactive, and a fleet scan showed what that
    # means in practice: every one of eleven projects at 0%, one of them owing
    # 106 entries for bugs closed months before the rule existed. A demand
    # nobody can meet is not a standard, it is a permanent warning people learn
    # to scroll past -- and the only escape it left, declaring the whole backlog
    # exempt, manufactures a list nobody will ever read.
    #
    # Keyed on the bug NUMBER rather than a date: numbers are already in the
    # anchors, monotonic per project, and need no date parsing across twelve
    # differently-formatted tables.
    def _num(bid):
        try:
            return int(bid.split("-", 1)[1])
        except (IndexError, ValueError):
            return 0

    fm = re.search(r'^\s*golden_required_from_bug\s*:\s*"?(B-\d+)"?\s*(#.*)?$', pol_txt, re.M)
    from_num = _num(fm.group(1)) if fm else None

    if not bug_ids:
        yield INFO, "golden coverage (R-4)", (
            "no bug log found at %s — nothing to guard yet." % os.path.relpath(buglist, root))
    elif from_num is None:
        # Not configured: report the backlog as a fact and name the one line
        # that turns the rule on, rather than demanding the whole history.
        nxt = max(_num(b) for b in bug_ids) + 1
        yield INFO, "golden coverage (R-4)", (
            "%d bug(s) logged, and no starting point set, so nothing is required yet. R-4 applies "
            "from the bug you nominate onward — add `evaluation.golden_required_from_bug: \"B-%02d\"` "
            "to casan-policies.yaml and every bug from there needs a golden case or a stated "
            "exemption. The %d already closed stay backlog; demanding cases for them retroactively "
            "is how a rule becomes a warning people scroll past."
            % (len(bug_ids), nxt, len(bug_ids)))
        bug_ids = None   # reported; the per-bug block below must not run too
    else:
        backlog = [b for b in bug_ids if _num(b) < from_num]
        bug_ids = [b for b in bug_ids if _num(b) >= from_num]
        if not bug_ids:
            yield OK, "golden coverage (R-4)", (
                "no bug logged since B-%02d; %d earlier bug(s) are backlog and not required."
                % (from_num, len(backlog)))
            bug_ids = None  # nothing further to report
    if bug_ids:
        missing = [b for b in bug_ids if b not in covered and b not in exempt]
        accounted = len(bug_ids) - len(missing)
        pct = int(accounted / len(bug_ids) * 100)
        # Exemptions are counted apart from real cases. Folding them together
        # would let a project reach "100%" by declaring everything exempt, and
        # the number would still read as coverage.
        tail = ("%d golden case(s), %d declared un-expressible. doctor checks that an "
                "exemption EXISTS — it cannot check the reason is true or that the "
                "regression test it names is real."
                % (len(covered & set(bug_ids)), len(exempt & set(bug_ids))))
        if not missing:
            yield OK, "golden coverage (R-4)", "all %d logged bugs accounted for: %s" % (len(bug_ids), tail)
        else:
            detail = ("%d of %d logged bugs accounted for (%d%%). Neither a golden case nor an "
                      "exemption: %s%s. A fixed bug with no case is a bug nothing will notice "
                      "coming back. || %s"
                      % (accounted, len(bug_ids), pct,
                         ", ".join(missing[:5]), " …" if len(missing) > 5 else "", tail))
            if strict:
                yield FAIL, "golden coverage (R-4)", detail + " (evaluation.require_golden_per_bug is true)"
            else:
                yield WARN, "golden coverage (R-4)", detail

    # 13) Agent Pack readiness (v1.6.0) — is the project's test runner configured?
    ac = os.path.join(H, "control", "agent-config.yaml")
    ac_txt = _read(ac)
    if not ac_txt:
        yield INFO, "agent pack", "agent-config.yaml not set — impact-review/run-affected-tests will fall back to full suite."
    elif "pick the line for your stack" in ac_txt:
        # The installer scaffolds this file from the shipped sample when it
        # cannot detect the stack, and the sample's ACTIVE lines are the Node
        # example with every other stack commented out below them. Reporting
        # that as "configured" is the C12 failure in miniature: the Agent Pack
        # would run, `enable-ci-gates` would generate a workflow from
        # full_suite_cmd, and a project that never touched the file would get a
        # gate that exists, runs the wrong command, and reads as coverage.
        yield WARN, "agent pack", (
            "agent-config.yaml is still the shipped SAMPLE — its active commands are the Node/Vitest "
            "example. Pick the lines for this project's stack and delete the rest, or the Agent Pack "
            "and any CI generated from it will run the wrong suite while reporting success.")
    else:
        yield OK, "agent pack", "agent-config.yaml present (review->fix->test runner configured)."

    # N) Bundle drift — do the files on disk still match the install receipt?
    #
    # The receipt records what the installer WROTE. Nothing has ever checked
    # that it is still what is THERE, and in this fleet .harness/ is committed
    # into each project's own git, so git is a competing source of truth: a
    # checkout, reset or pull silently restores an older copy of any bundled
    # file while the receipt keeps claiming the new version.
    #
    # Found live on 2026-08-17: two projects were running an old
    # harness_doctor.py that predates --json, so the Portal had received no
    # doctor report from one for 21 hours and from the other for 2.4 days --
    # and nothing anywhere said so. The updater had reported success, because
    # it HAD written the files; git overwrote them afterwards.
    #
    # Hashing only the scripts/lib + scripts/* trees on purpose: control/ and
    # eval/ hold files a project is SUPPOSED to edit (its own policies, its own
    # golden cases -- see the bundle's `preserve` list), so drift there is
    # normal and flagging it would be the cry-wolf failure C14 forbids.
    receipt_path = os.path.join(H, ".bundle-manifest.json")
    if not os.path.exists(receipt_path):
        yield INFO, "bundle integrity", "no .bundle-manifest.json — this project was not installed from a bundle."
    else:
        try:
            receipt = json.loads(_read(receipt_path) or "{}")
            recorded = receipt.get("files") or {}
            version = receipt.get("version") or "?"
            # Only entries the receipt carries a hash for can be compared; an
            # older receipt shape simply yields nothing to check, and says so
            # rather than passing silently.
            checked = drifted = 0
            examples = []
            for entry in recorded:
                if not isinstance(entry, dict):
                    continue
                rel = entry.get("path") or ""
                # installed_sha256 is what the installer actually wrote (it can
                # differ from sha256 for a file the installer templated); it is
                # the honest baseline for "is this still what we installed".
                want = entry.get("installed_sha256") or entry.get("sha256")
                if not rel or not want:
                    continue
                norm = rel.replace("\\", "/")
                if not (norm.startswith(".harness/scripts/") or norm.startswith("tools/harness-bundle/")):
                    continue
                target = os.path.join(root, norm.replace("/", os.sep))
                if not os.path.exists(target):
                    drifted += 1
                    if len(examples) < 3:
                        examples.append(norm + " (missing)")
                    continue
                checked += 1
                h = hashlib.sha256(open(target, "rb").read()).hexdigest()
                if h != want:
                    drifted += 1
                    if len(examples) < 3:
                        examples.append(norm)
            if checked == 0 and drifted == 0:
                yield INFO, "bundle integrity", (
                    "receipt for v%s carries no per-file hashes — cannot verify the installed files "
                    "are still the ones that were installed. Re-install with a current packer to enable "
                    "this check." % version)
            elif drifted:
                yield FAIL, "bundle integrity", (
                    "%d of %d bundled script(s) no longer match the v%s receipt (%s). Something "
                    "overwrote them after install -- in this fleet that is usually the project's own "
                    "git, which tracks .harness/. Re-install the bundle, then COMMIT it, or the next "
                    "checkout restores the old copy again."
                    % (drifted, checked + drifted, version, ", ".join(examples)))
            else:
                yield OK, "bundle integrity", "%d bundled script(s) match the v%s receipt." % (checked, version)
        except Exception as e:
            yield WARN, "bundle integrity", "could not verify bundle files: %s" % e


def as_json(root):
    """The same run, as the JSON the push client sends to the Portal (S-1).

    Emitting the identical check list the terminal shows -- not a summary -- so
    the Portal renders exactly what the developer saw. A health screen that
    paraphrases its source is a second place for the truth to drift.
    """
    checks = [{"status": s, "label": l, "detail": d} for s, l, d in run(root)]
    counts = {k: sum(1 for c in checks if c["status"] == k) for k in (OK, WARN, FAIL, INFO)}
    if counts[FAIL]:
        verdict = "failing"
    elif counts[WARN]:
        verdict = "thin"
    else:
        verdict = "healthy"
    return {
        "ran_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "counts": counts,
        "verdict": verdict,
        "checks": checks,
    }


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
    want_json = False
    for a in argv[1:]:
        if a == "--strict":
            strict = True
        elif a == "--json":
            want_json = True
        elif a in ("-h", "--help"):
            print("usage: harness_doctor.py [ROOT] [--strict] [--json]"); return 0
        elif not a.startswith("-"):
            root = a
    root = os.path.abspath(root)

    if want_json:
        # Machine output only -- no banner, so the caller can pipe it straight
        # into the push payload.
        print(json.dumps(as_json(root), ensure_ascii=False))
        return 0

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
