#!/usr/bin/env python3
"""policy-ci -- the regression suite the CASAN evaluation layer requires.

`.harness/control/casan-policies.yaml` declares
`evaluation.regression_suites_required` and gates a release on those suites
passing. This is the bundle's reference implementation of `policy-ci`: it
enforces the governance conventions the constitution states (C2/C4/C5/C8/C10)
against the ACTUAL policy files, so config drift fails here instead of being
discovered at a gateway.

Deliberately generic -- every check reads the project's own policy files, so it
is meaningful in any project the bundle is dropped into. No project paths are
hardcoded.

Dependencies: stdlib. PyYAML is used when available; without it the YAML-only
checks report as SKIPPED rather than silently passing (C10 -- never fabricate a
green run).

Reporting: prints counts in the format `harness-eval` parses ("Passed : N"), so
the eval runner stays the single writer of test-reports.jsonl.

Usage:  python harness_policy_check.py <repo_root>
Exit:   0 when nothing failed, 1 on any failure (usable directly as a CI gate).
"""
import glob
import json
import os
import re
import sys

try:
    import yaml  # type: ignore
    _HAS_YAML = True
except Exception:  # pragma: no cover - environment dependent
    _HAS_YAML = False

PASSED, FAILED, SKIPPED = [], [], []


def ok(name):
    PASSED.append(name)


def fail(name, why):
    FAILED.append("%s: %s" % (name, why))


def skip(name, why):
    SKIPPED.append("%s: %s" % (name, why))


def load(path):
    with open(path, encoding="utf-8-sig") as f:
        text = f.read()
    if path.endswith(".json"):
        return json.loads(text)
    if not _HAS_YAML:
        raise RuntimeError("PyYAML not installed")
    return yaml.safe_load(text)


def control_files(control):
    if not os.path.isdir(control):
        return []
    return sorted(
        os.path.join(control, n)
        for n in os.listdir(control)
        if os.path.splitext(n)[1] in (".json", ".yaml", ".yml")
    )


# --------------------------------------------------------------- schema subset
def check_schema(instance, schema, where):
    """Minimal JSON-Schema subset: type + required + property types. Enough to
    catch a malformed or gutted policy; not a full validator (jsonschema is not
    a bundle dependency)."""
    errs = []
    pyt = {"object": dict, "array": list, "string": str,
           "integer": int, "number": (int, float), "boolean": bool}
    t = schema.get("type")
    if t in pyt and not isinstance(instance, pyt[t]):
        if not (t in ("integer", "number") and isinstance(instance, bool)):
            return ["%s: expected %s, got %s" % (where, t, type(instance).__name__)]
    if t == "object" and isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errs.append("%s: missing required key '%s'" % (where, key))
        for key, sub in (schema.get("properties") or {}).items():
            if key in instance and isinstance(sub, dict) and "type" in sub:
                errs.extend(check_schema(instance[key], sub, "%s.%s" % (where, key)))
    return errs


# ------------------------------------------------------------------ C5 secrets
# Live-secret shapes, NOT placeholders -- kept narrow so docs that talk ABOUT
# secrets are not flagged.
SECRET_RE = [
    re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{40,}"),
    re.compile(r"sk-[A-Za-z0-9]{32,}"),
    re.compile(r"gsk_[A-Za-z0-9]{40,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{20,}"),
]
# Pattern files legitimately contain secret-shaped regexes; test fixtures carry
# dummy keys. Skipping them is what keeps this check signal, not noise.
SECRET_SKIP = re.compile(r"(patterns\.json|golden-cases|test_|[\\/]tests?[\\/]|conftest)")

ALLOWED_MODELS = {
    "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5",
    "claude-haiku-4-5-20251001", "claude-haiku-4-5",
}

H_LAYERS = ("context", "tool", "evaluation", "security",
            "governance", "agentops", "orchestration")


def run(root):
    harness = os.path.join(root, ".harness")
    control = os.path.join(harness, "control")
    schemas = os.path.join(harness, "schemas")

    # ---- layout ----------------------------------------------------------
    if os.path.isdir(control) and os.path.isdir(schemas) and control_files(control):
        ok("layout")
    else:
        fail("layout", "missing .harness/control, .harness/schemas, or policy files")
        return  # nothing below is meaningful

    # ---- every policy parses --------------------------------------------
    parsed = {}
    for p in control_files(control):
        name = os.path.basename(p)
        try:
            data = load(p)
        except RuntimeError as e:
            skip("parses:" + name, str(e))
            continue
        except Exception as e:
            fail("parses:" + name, "does not parse (%s)" % e)
            continue
        if data is None:
            fail("parses:" + name, "parsed to nothing")
        else:
            parsed[name] = data
            ok("parses:" + name)

    # ---- C8: JSON policies are schema-backed and satisfy their schema ----
    exempt = {"injection-patterns.json", "secret-patterns.json"}
    for p in control_files(control):
        name = os.path.basename(p)
        if not name.endswith(".json") or name in exempt:
            continue
        sp = os.path.join(schemas, os.path.splitext(name)[0] + ".schema.json")
        if not os.path.isfile(sp):
            fail("C8:schema-exists:" + name, "no matching schema in .harness/schemas")
        else:
            ok("C8:schema-exists:" + name)
    for name, data in parsed.items():
        sp = os.path.join(schemas, os.path.splitext(name)[0] + ".schema.json")
        if not os.path.isfile(sp):
            continue
        try:
            errs = check_schema(data, load(sp), name)
        except Exception as e:
            skip("C8:schema-valid:" + name, str(e))
            continue
        if errs:
            fail("C8:schema-valid:" + name, "; ".join(errs))
        else:
            ok("C8:schema-valid:" + name)

    # ---- C4 + C10 on casan-policies -------------------------------------
    casan = parsed.get("casan-policies.yaml")
    if casan is None:
        skip("C4:model-ladder", "casan-policies.yaml unavailable")
        skip("C10:h-layers", "casan-policies.yaml unavailable")
    else:
        ladder = (casan.get("orchestration") or {}).get("model_fallback") or {}
        if not ladder:
            fail("C4:model-ladder", "orchestration.model_fallback not declared")
        else:
            named = set()
            for chain in ladder.values():
                named.update(chain if isinstance(chain, list) else [chain])
            stray = sorted(m for m in named if m not in ALLOWED_MODELS)
            if stray:
                fail("C4:model-ladder", "unlicensed model IDs: %s" % stray)
            else:
                ok("C4:model-ladder")

        missing = [L for L in H_LAYERS if L not in casan]
        no_enf = [L for L in H_LAYERS
                  if L in casan and isinstance(casan[L], dict) and "enforced_at" not in casan[L]]
        if missing or no_enf:
            fail("C10:h-layers", "missing layers %s; missing enforced_at %s" % (missing, no_enf))
        else:
            ok("C10:h-layers")

    # ---- H1: the pointer store honours the context contract --------------
    if casan is None:
        skip("H1:pointer-store", "casan-policies.yaml unavailable")
    else:
        ctx = casan.get("context") or {}
        rel = ctx.get("pointer_store") or ".harness/context/pipeline-context.yaml"
        store = os.path.join(root, rel.replace("/", os.sep))
        if not os.path.isfile(store):
            fail("H1:pointer-store", "missing pointer store: %s" % rel)
        else:
            try:
                data = load(store) or {}
            except RuntimeError as e:
                data = None
                skip("H1:pointer-store", str(e))
            except Exception as e:
                data = None
                fail("H1:pointer-store", "does not parse (%s)" % e)
            if data is not None:
                problems = []
                for key in ctx.get("required_keys", []):
                    if key not in data or data[key] in ("", None, []):
                        problems.append("missing/empty required key '%s'" % key)
                for ptr in ("srs_path", "spec_path"):
                    v = data.get(ptr)
                    if v and not os.path.exists(os.path.join(root, v.replace("/", os.sep))):
                        problems.append("%s -> '%s' does not exist (dangling)" % (ptr, v))
                if problems:
                    fail("H1:pointer-store", "; ".join(problems))
                else:
                    ok("H1:pointer-store")

    # ---- plane separation: the harness governs the ASSISTANT, not the product
    # casan-policies declares Claude model ids under orchestration.model_fallback.
    # In a repo whose PRODUCT also calls LLMs, that reads like "the model fallback
    # chain", and wiring the product gateway to it looks like an H7 uplift. It is
    # an outage: an assistant-plane model id sent to another provider's endpoint
    # fails every call, and surfaces as a bad KEY rather than a bad model name.
    # Two assertions -- the second catches the runtime-lookup form that grepping
    # for model ids alone would miss.
    # Each H layer states its plane in machine-readable form, so this check --
    # and any consumer -- can assert it instead of parsing a comment. Absent is
    # SKIP, not FAIL: casan-policies.yaml is preserved on upgrade, so a project
    # that predates the field must not have its release gate broken by it.
    if casan is None:
        skip("plane:governs-declared", "casan-policies.yaml unavailable")
    else:
        declared = {L: (casan.get(L) or {}).get("governs")
                    for L in H_LAYERS if isinstance(casan.get(L), dict)}
        wrong = sorted("%s=%r" % (L, v) for L, v in declared.items()
                       if v is not None and v not in ("assistant_workflow", "product_runtime"))
        absent = sorted(L for L, v in declared.items() if v is None)
        if wrong:
            fail("plane:governs-declared",
                 "unknown plane (expected assistant_workflow|product_runtime): %s" % ", ".join(wrong))
        elif absent:
            skip("plane:governs-declared",
                 "layers without `governs:` -- add it to state the plane: %s" % ", ".join(absent))
        else:
            ok("plane:governs-declared")

    src_dirs = []
    for g in ((casan or {}).get("context") or {}).get("source_globs") or []:
        for m in glob.glob(os.path.join(root, g.replace("/", os.sep))):
            d = m if os.path.isdir(m) else os.path.dirname(m)
            rel = os.path.relpath(d, root) if d else ""
            if rel and rel != "." and os.path.isdir(d) and not rel.startswith((".harness", ".claude", ".git")):
                if rel not in src_dirs:
                    src_dirs.append(rel)
    if not src_dirs:
        skip("plane:no-assistant-model-in-product", "context.source_globs matches no product directory in this repo")
        skip("plane:product-does-not-read-harness", "context.source_globs matches no product directory in this repo")
    else:
        model_ids = set()
        for chain in ((casan.get("orchestration") or {}).get("model_fallback") or {}).values():
            model_ids.update(chain if isinstance(chain, list) else [chain])
        try:
            pp = load(os.path.join(control, "power-policy.json"))
            for v in (pp.get("model_tier_map") or {}).values():
                # A tier maps to ONE model id (str) in some configs and to a
                # fallback LIST in others (this repo's own power-policy.json is
                # the list shape) -- the old `isinstance(v, str)` guard silently
                # dropped every list-shaped tier, so only orchestration's own
                # model_fallback ever fed this check.
                model_ids.update(v if isinstance(v, list) else [v])
        except Exception:
            pass
        # No vendor prefix filter: these ids come from the harness's OWN
        # assistant-plane config (orchestration.model_fallback /
        # power-policy.json), so whatever is configured there IS the
        # assistant-plane id, whichever vendor a deployment actually pins (C4 --
        # "Fable 5/Opus 4.8/Sonnet 5/Haiku 4.5" is THIS harness's chosen ladder,
        # not the only ladder the check can recognize). The old
        # `m.startswith("claude-")` filter meant a deployment pinned to a
        # different vendor's model ids would silently produce an EMPTY set here
        # -- the check would report green having verified nothing.
        model_ids = {m for m in model_ids if isinstance(m, str) and m.strip()}

        leak_model, leak_harness = [], []
        for rel in src_dirs:
            for dirpath, _d, files in os.walk(os.path.join(root, rel)):
                if any(part in dirpath for part in ("node_modules", "__pycache__", ".venv", "dist", "build")):
                    continue
                for fn in files:
                    if os.path.splitext(fn)[1] not in (".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".java", ".rb", ".php", ".cs"):
                        continue
                    fp = os.path.join(dirpath, fn)
                    try:
                        text = open(fp, encoding="utf-8", errors="ignore").read()
                    except Exception:
                        continue
                    where = os.path.relpath(fp, root)
                    for mid in model_ids:
                        if mid in text:
                            leak_model.append("%s: %s" % (where, mid))
                            break
                    # `.harness` followed by any separator, so both "/.harness/x"
                    # and an escaped Windows path in source are caught.
                    if re.search(r"\.harness[\\/]", text):
                        leak_harness.append(where)
        if leak_model:
            fail("plane:no-assistant-model-in-product",
                 "assistant-plane model id in product code: " + "; ".join(leak_model[:5]))
        else:
            ok("plane:no-assistant-model-in-product")
        if leak_harness:
            fail("plane:product-does-not-read-harness",
                 "product code reads .harness/: " + "; ".join(leak_harness[:5]))
        else:
            ok("plane:product-does-not-read-harness")

    # ---- C5: no hardcoded secrets in the governed surface -----------------
    hits = []
    for rel in (".harness/control", ".harness/scripts", ".harness/schemas", "contracts"):
        base = os.path.join(root, rel.replace("/", os.sep))
        if not os.path.isdir(base):
            continue
        for dirpath, _dirs, files in os.walk(base):
            for fn in files:
                fp = os.path.join(dirpath, fn)
                if os.path.splitext(fn)[1] in (".pyc", ".png", ".jpg", ".gz", ".key"):
                    continue
                if SECRET_SKIP.search(fp):
                    continue
                try:
                    with open(fp, encoding="utf-8", errors="ignore") as f:
                        text = f.read()
                except Exception:
                    continue
                for rx in SECRET_RE:
                    m = rx.search(text)
                    if m:
                        v = m.group(0)
                        # Report the location, MASK the value -- never echo a secret.
                        hits.append("%s: %s...%s" % (os.path.relpath(fp, root), v[:4], v[-4:]))
                        break
    if hits:
        fail("C5:no-hardcoded-secrets", "; ".join(hits))
    else:
        ok("C5:no-hardcoded-secrets")

    # ---- C8: a bundle manifest must be real YAML --------------------------
    # The packer reads bundle.yaml line-by-line, so a manifest can carry an
    # unescaped quote inside a double-quoted scalar, pack cleanly, and still be
    # unparseable to every other consumer. Only meaningful in a repo that
    # PUBLISHES bundles; a consuming project has no bundles/ and skips.
    manifests = sorted(glob.glob(os.path.join(root, "bundles", "*", "bundle.yaml")))
    if not manifests:
        skip("C8:bundle-manifest-parses", "no bundles/*/bundle.yaml in this repo")
    else:
        bad = []
        for m in manifests:
            rel = os.path.relpath(m, root)
            try:
                data = load(m)
            except RuntimeError as e:
                bad = None
                skip("C8:bundle-manifest-parses", str(e))
                break
            except Exception as e:
                bad.append("%s: %s" % (rel, str(e).split("\n")[0]))
                continue
            for key in ("name", "version", "description"):
                if not (isinstance(data, dict) and data.get(key)):
                    bad.append("%s: missing '%s'" % (rel, key))
        if bad:
            fail("C8:bundle-manifest-parses", "; ".join(bad))
        elif bad is not None:
            ok("C8:bundle-manifest-parses")


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else ".")
    print("Passed : %d" % len(PASSED))
    print("Failed : %d" % len(FAILED))
    print("Skipped : %d" % len(SKIPPED))
    for f in FAILED:
        print("  FAIL " + f)
    for s in SKIPPED:
        print("  SKIP " + s)
    sys.exit(1 if FAILED else 0)
