"""Shared helpers for the idempotency hooks (H2). POSIX-side counterpart of
lib-idempotency.ps1 (C7).

Imported by idempotency-checkpoint.sh (PreToolUse) and idempotency-record.sh
(PostToolUse) so both sides compute the key the SAME way. Two hooks that
disagree on the key never see each other's records, and the checkpoint then
reports "no duplicate" forever while looking installed -- the silent-pass
failure this harness exists to prevent.

A real module rather than a shell string spliced into a heredoc: an unquoted
heredoc lets bash interpret the dollar and backslash characters inside the
Python source, which turns a regex into something else with no error at all.

C2: the tool list, TTL and rate limits are read from casan-policies.yaml.
Nothing about them is hardcoded here.

KNOWN LIMIT, stated rather than papered over: the key is sha256 over the tool
name plus its input as compact JSON, and PowerShell's ConvertTo-Json and
Python's json.dumps are not guaranteed to agree byte-for-byte on every input. A
lock store written on Windows is therefore not guaranteed to be recognised here,
or the reverse. That matters only when the same repo is driven from both OSes
against one store; on a single machine each side is self-consistent. Do not
describe this as cross-OS idempotency.
"""
import hashlib
import json
import os
import re

LOCK_SUFFIX = ".hook.json"


def hook_record():
    """The hook JSON, or None. Passed by env because a heredoc owns stdin."""
    try:
        return json.loads(os.environ.get("HARNESS_HOOK_INPUT", ""))
    except Exception:
        return None


def tool_of(d):
    return d.get("tool_name") or d.get("tool") or ""


def input_of(d):
    v = d.get("tool_input")
    if v is None:
        v = d.get("input")
    return v


def policy_lines(path):
    # utf-8-sig: a policy file last written by PowerShell 5.1 can carry a BOM,
    # and then the first line is not what a strict reader expects.
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as f:
            return f.read().splitlines()
    except OSError:
        return []


def policy_list(path, section, key):
    """A YAML list under section.key, scanned exactly the way the .ps1 scans it.

    Deliberately the same shallow parse, not a better one: if the two shells
    disagree about what the policy says, the project is governed differently
    depending on the machine, which is the very thing C7 is about.
    """
    out, in_section, in_list = [], False, False
    for line in policy_lines(path):
        if re.match(r"^%s:" % re.escape(section), line):
            in_section = True
            continue
        if in_section and re.match(r"^[a-z_]+:", line):
            break
        if in_section and re.match(r"^\s+%s:" % re.escape(key), line):
            in_list = True
            continue
        if in_list:
            m = re.match(r'^\s+-\s+"?([^"#]+?)"?\s*(#.*)?$', line)
            if m:
                out.append(m.group(1).strip())
            elif re.match(r"^\s+[a-z_]+:", line):
                in_list = False
    return out


def policy_scalar(path, section, key, default):
    in_section = False
    for line in policy_lines(path):
        if re.match(r"^%s:" % re.escape(section), line):
            in_section = True
            continue
        if in_section and re.match(r"^[a-z_]+:", line):
            break
        if in_section:
            m = re.match(r"^\s+%s:\s*([0-9]+)" % re.escape(key), line)
            if m:
                return int(m.group(1))
    return default


def rate_limit_for(path, base):
    """(unit, count) from tool.rate_limits.<base>, or (None, None)."""
    in_tool = in_limits = False
    for line in policy_lines(path):
        if re.match(r"^tool:", line):
            in_tool = True
            continue
        if in_tool and re.match(r"^[a-z_]+:", line):
            break
        if in_tool and re.match(r"^\s+rate_limits:", line):
            in_limits = True
            continue
        if in_limits:
            m = re.match(r"^\s+%s:\s*\{\s*per_(minute|hour):\s*(\d+)" % re.escape(base), line)
            if m:
                return m.group(1), int(m.group(2))
            if re.match(r"^\s+[a-z_]+:\s*$", line):
                in_limits = False
    return None, None


def resolve_tool(tool_name, required):
    """Matches a bare name (deploy) and an MCP name (mcp__server__deploy)."""
    for r in required:
        if tool_name == r or tool_name.endswith("__" + r) or tool_name.endswith("." + r):
            return r
    return None


def is_write_call(base, tool_input):
    """mysql_query only counts as a side-effect when it WRITES. The policy says
    so in a comment; both shells have to agree on that reading."""
    if base != "mysql_query":
        return True
    ti = tool_input if isinstance(tool_input, dict) else {}
    sql = "%s%s" % (ti.get("query") or "", ti.get("sql") or "")
    if not sql:
        return True
    return bool(re.search(
        r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b",
        sql, re.I | re.S))


def idempotency_key(tool_name, tool_input):
    canon = json.dumps(tool_input, separators=(",", ":")) if tool_input else "{}"
    return hashlib.sha256(("%s|%s" % (tool_name, canon)).encode("utf-8")).hexdigest()
