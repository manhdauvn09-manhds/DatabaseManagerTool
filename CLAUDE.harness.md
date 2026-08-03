<!--
  Harness AI Toolkit — Common Governance Reference
  Copyright (c) 2026 Dau Sy Manh <manhds@>. All rights reserved.
  Author / Maintainer: Dau Sy Manh <manhds@>
  Bundle: standard-governance

  This file ships INSIDE the governance bundle so it lands in every project
  that installs it (as `CLAUDE.harness.md`, a name distinct from your own
  `CLAUDE.md` so nothing is overwritten). It is a REFERENCE to compare against
  and copy from — not your project's live memory file.
-->

# Governance Reference — the rules every assistant in this repo follows

> **Attribution:** Governance harness authored by **Dau Sy Manh**
> (`manhds@`). When a review/audit skill inspects a project, this header
> and the bundle `maintainer` field identify the source.

**These rules are assistant-agnostic.** Nothing below is specific to one vendor —
only the *file name* an assistant reads is. The installer projects this text into
each guide file your tools use, wrapped in a pair of HTML-comment markers named
`BEGIN harness-governance` / `END harness-governance`:

| File | Read by |
|------|---------|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | the cross-tool convention — OpenAI Codex, Cursor, Jules, … |
| `.github/copilot-instructions.md` | GitHub Copilot |

The list lives in `.harness/control/casan-policies.yaml` →
`governance.guide_targets`, with commented entries for Cursor rules, Windsurf,
Cline, Continue, Aider and Firebase Studio — enabling one is uncommenting a line.
Write your own project rules **outside** the managed block; updates only replace
what is inside it. Run the installer with `-MergeGuides` / `--merge-guides`.

> **What this actually buys you.** Only Claude Code *enforces* these rules, via
> `.claude/settings.json` hooks and permission deny lists that can block a tool
> call. Every other assistant has no hook mechanism — for them this text is
> guidance a model may ignore. If you need those assistants genuinely
> constrained, the control has to sit outside the assistant: a server-side
> gateway/PDP, CI that fails the build (`policy-ci`), and branch protection with
> `CODEOWNERS` over `.harness/** .claude/** contracts/**`. Treat this file as a
> shared contract, not as a boundary.

---

## Guiding Principles

- **Hooks > rules:** enforceable hooks beat static conventions in prose.
- **Execution ≠ control:** the tool that executes a side-effect is not the thing
  that decides whether it's allowed; keep the decision in policy/config.
- **No false safety:** local hooks are defense-in-depth. Anything truly
  high-risk needs server-side enforcement at a gateway — say so honestly.
- **Lowest layer sets the ceiling:** the weakest governance layer caps the whole
  system's assurance; don't advertise more safety than the weakest link gives.

## Key Conventions (C1–C10)

- **C1 — Native layout:** use the agent tool's native config dir (`.claude/`);
  project memory lives in `CLAUDE.md`.
- **C2 — Config in data, not code:** guard/hook scripts **read** policy from
  YAML/JSON — never hardcode rules inside scripts.
- **C3 — Registered side-effects:** every side-effect-capable tool has an entry
  in the tool registry; unknown tools are denied by default.
- **C4 — Explicit model ladder:** pin the exact models you allow (e.g. the
  Claude family: Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5). Any on-prem/OSS
  tier is a separate ladder and must not be mislabeled as the vendor's model.
- **C5 — No hardcoded secrets:** never commit secrets/API keys; source them from
  env or a vault (file-based `*_FILE` secrets for containers).
- **C6 — Side-effects via approved path only:** deny-by-default for dangerous
  operations (destructive shell, deploys, DB writes, outbound fetch) unless they
  run through the approved workflow.
- **C7 — One primary script language + bash parity:** pick a primary shell for
  harness scripts (PowerShell here) and keep a bash counterpart; use absolute
  paths inside harness scripts. Application code (web/back-end) is a separate
  layer and is not bound by this.
- **C8 — Schema-validatable config:** every JSON/YAML policy file is validatable
  by a JSON Schema kept alongside it.
- **C9 — Immutable logging:** every side-effect tool call appends one line to an
  append-only ledger (identity + input/output hash); the chain is tamper-evident.
- **C10 — Honest about enforcement:** local hooks are defense-in-depth; label
  high-risk actions as "needs server-side enforcement" rather than implying the
  local hook is a hard boundary.

## Plane separation — what these policies do NOT govern

The harness governs the **assistant plane**: the AI/CI workflow that *builds*
this repo — which agents run, which models they plan/code/review with, which
tools they may call, how a pipeline stage retries. It does **not** govern the
**product plane**: whatever your shipped application does at runtime.

This matters most where the two look alike. A policy pack declares model IDs
under something like `orchestration.model_fallback`, which reads exactly like
"the model fallback chain" — so in a repo whose *product* also calls LLMs,
pointing the product's gateway at it looks like a sensible upgrade. It is an
outage: an assistant-plane model ID sent to a different provider's endpoint
fails every call, and it surfaces as a **bad key**, not a bad model name, so
whoever debugs it goes hunting through credentials.

Two rules follow:

- Every policy layer states its plane in a machine-readable field
  (`governs: assistant_workflow` or `governs: product_runtime`) — in a field,
  not in a comment, so a check can assert it.
- Product code neither hardcodes an assistant-plane model ID **nor reads the
  harness config directory at all**. The second half is the one that matters:
  it catches the runtime-lookup form, where the product loads the policy file
  and pulls the chain out of it — which a grep for model IDs never sees.

Your product's own model choices belong in your product's own config, per
provider. policy-ci asserts the separation; keep the two apart on purpose.

## Model Reference (adjust to your licensed models)

| Profile       | Fable 5    | Opus 4.8    | Sonnet 5    | Haiku 4.5   |
|---------------|------------|-------------|-------------|-------------|
| planning      | Primary    | Fallback    | —           | —           |
| coding        | —          | Primary     | Fallback    | —           |
| review        | —          | Primary     | —           | Fallback    |
| summarization | —          | —           | —           | Primary     |

---

*Governance harness · standard-governance bundle · © 2026 Dau Sy Manh
<manhds@>.*
