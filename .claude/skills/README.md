# Harness Skills (L2 — knowledge layer)

Each `<name>/SKILL.md` is a task-scoped capability with validated frontmatter
(`.harness/schemas/skill.schema.json`). Validate all skills:

```
python tools/harness-skill/validate-skills.py
```

## Skills by pipeline stage

The core AI-SDLC DAG (`contracts/workflow.yaml`) is analysis → implementation →
verification; the harness-native skills map onto it, with broader lifecycle
skills around the edges.

| Stage (DAG / lifecycle) | Skill | Agents | Output |
|---|---|---|---|
| planning | `fan` | boss | fan-out-report |
| requirement | `deep-research` | researcher, analyst | research-report |
| **intake** | `verify-request` | gatekeeper | intake-doc |
| **analysis** | `analyze-requirements` | analyst, architect | analysis-doc |
| **implementation** | `implement-change` | developer | code-diff |
| implement (repair) | `fix-and-verify` | developer, tester | fix-verification-report |
| **test** | `run-affected-tests` | targeted-tester, tester | test-report |
| security | `be-fe-security-audit` | reviewer, researcher | security-audit-report |
| **verification** | `verify-implementation` | reviewer, tester | verdict |
| verification (loop) | `impact-review` | impact-analyzer, code-reviewer, fix-agent, targeted-tester, reviewer, qa-reviewer | verdict |
| **qa-gate** | `qa-gate` | qa-reviewer | qa-verdict |
| governance (H5) | `evidence-bundle` | reviewer, writer | evidence-bundle |
| release | `deploy-to-test` | devops | deployment-report |
| release | `commit-deploy-log` | developer, devops, writer | cycle-report |

**Bold** = the core DAG stages, added in L2 so every pipeline node has a
formal, agent-scoped skill (previously only the surrounding lifecycle phases
did). `implement` is the legacy stage alias for `implementation`.

The DAG's `test` stage got its dedicated skill in v1.6.0: `run-affected-tests`
(previously the one node with none — the `tester` agent ran suites ad hoc).
`impact-review` is the Agent Pack's orchestration skill — the review→fix→test
loop scoped to a change's blast radius — which all nine 2026-08-03 consuming
projects independently designed before it was standardized here.
