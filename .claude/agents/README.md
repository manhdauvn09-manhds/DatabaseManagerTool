# Agent fleet — 11 agents

`contracts/agent.yaml` is the SSOT: it owns each agent's model profile, authority,
and its allowed/blocked tool lists. The `.md` files here hold the *instructions* an
agent runs on. When the two disagree, the contract wins — the `.md` cannot grant
itself a tool the contract blocks.

| Agent | Tier | Profile | Stage | Writes code? | Purpose |
|---|---|---|---|---|---|
| `boss` | 3 | planning | — | via delegation | Orchestrates, delegates, owns `pipeline-context.yaml` |
| `architect` | 2 | planning | — | no | Architecture, ADRs, trade-offs |
| `analyst` | 2 | planning | analysis | no | Requirement analysis, spec review |
| `researcher` | 2 | planning | — | no | Deep investigation, dependency/vuln research |
| `developer` | 2 | coding | implementation | **yes** | Implements changes per the analysis |
| `tester` | 2 | coding | test | **yes** (tests) | Writes and runs suites, produces the report |
| `devops` | 2 | coding | — | **yes** | CI/CD, deploys, infra-as-code |
| `reviewer` | 2 | review | verification | no | Verifies the implementation meets requirements |
| `writer` | 2 | summarization | — | **yes** (docs) | Documentation, changelogs, migration guides |
| `gatekeeper` | 2 | **planning-light** | **intake** | no | Pre-code triage — added v1.6.0 |
| `qa-reviewer` | 2 | review | **qa-gate** | no | Adversarial final gate — added v1.6.0 |

## The two gates (v1.6.0)

`gatekeeper` and `qa-reviewer` bracket the coding stages: one runs before any code
exists, the other after it does. Both are read-only by construction, because a gate
that can edit what it judges is not a gate.

- **`gatekeeper`** answers the question no other stage asks: *is this the right
  thing to build at all?* Before v1.6.0 the pipeline ran straight from a request
  into analysis, so a misread request produced a clean, well-reviewed, fully tested
  implementation of the wrong thing — and every later stage judged it against the
  same misreading, so nothing caught it. Runs on `planning-light` deliberately:
  intake fires on every request, and paying for the top planning model to make a
  triage call a small model makes well is the wrong trade.

- **`qa-reviewer`** is the last thing before a release tool may run, and is a
  *second adversarial* review rather than a stamp on the first. `verification` asks
  "does this meet the criteria"; `qa-gate` assumes it does not and goes looking.
  It holds `Bash` for exactly one reason — to run the test suites — because its
  defining rule is unenforceable otherwise: **if the suites were not actually run,
  the verdict is CHANGES_REQUIRED, never APPROVED.** An APPROVED resting on an
  unrun suite is worse than no gate at all: it launders "unknown" into "verified",
  and the deny hook then waves the release through.

To record a verdict, `qa-reviewer` holds `__workflow_gate__` — a *virtual* tool
with no executor behind it, constrained by schema to `side_effect: false` /
`risk_level: none`. That exists so recording an outcome never requires granting a
real write tool to the agent judging the code.

## Honest about enforcement (C10)

The tool lists in `contracts/agent.yaml` are enforced for Claude Code through
`.claude/settings.json` hooks and permission deny lists, which can genuinely block a
call. For any other assistant there is no hook mechanism, so the same lists are
guidance a model may ignore. Anything that must actually be prevented needs
server-side enforcement at the gateway — not a line in this table.
