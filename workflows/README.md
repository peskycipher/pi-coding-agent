# Workflows — Agent Suite Specification

Design for a two-tier multi-agent coding suite: an External Orchestrator (EO) on the
developer's machine supervises an Internal Orchestrator (IO) inside a sandbox, which
drives read-only/context-isolated specialists over a JSON bus with a persisted ledger.
**Status: specification only** — no component is implemented in this repo's runtime yet
(the runtime remains a single-task sandbox); see Adoption status below.

## Architecture

```
Developer ⇄ EO (local) ── TASK/STATUS/CLARIFICATION/COMPLETION/FAILURE/ARTIFACT_*
                              ⇅ JSON envelopes, one version at a time
                         IO (sandbox) ── ledger (blackboard, append-only, EO-persisted)
                              ⇅ DISPATCH/RESULT, specialists never talk to each other
                    { scout | plan | build | test | docs }   (+ adversarial gate: steelman/contrarian, conditional attach)
```

First-pass reading order: `README` → `orchestrator-external/design.md` →
`orchestrator-external/protocol.md` → `orchestrator-internal/design.md` →
`orchestrator-internal/protocol.md` → one specialist pair (start with `scout/README.md`)
→ `observability/plan.md`. Bindings when deploying: `bindings.md`. Evals when qualifying:
`test-eval-spec.md`.

## The two roles (canonical definitions)

Every document in this suite uses these definitions; no section redefines them:

- **IO — Internal Orchestrator:** manages **a single development pipeline from within its
  own sandbox** — intake, delegation to specialists, contract validation, aggregation,
  and reporting upward. It owns one pipeline, nothing else: the task's purpose, sandbox
  lifecycle (provisioning/destruction), and durable-artifact merging are not its role,
  and it asks rather than assumes when pipeline needs collide with them.
- **EO — External Orchestrator:** manages, **as required: the purpose** (task contract
  with the developer: goal, constraints, done-criteria), **the provisioning** (sandbox
  creation, profile, tool inventory, binding application) and **destruction** (teardown,
  sandbox end) **and the merging of artifacts** (applying patches, opening/merging PRs,
  tags — everything that lands in the durable repo). It never runs pipeline stages.

The crisp line: the IO **aggregates** specialist results into pipeline state; the EO
**merges** artifacts into durable history. The specialist never confuses them — it has
exactly one channel, `RESULT` to the IO, and never addresses the EO or the developer.

Key invariants (see the protocol docs for the full set):
- **Trust boundary at the EO**: capability-based approval gates, secret redaction, fetch
  allowlist — the IO cannot bypass a gate because the capability is never dispatched.
- **The ledger is the only durable state**; the EO persists it and stamps `seq`.
- **Contracts are machine-checked**: `schemas/` holds the executable form of every wire
  type and RESULT contract; schema failure = specialist failure.

## Document map

| Component | Read | Status |
|---|---|---|
| Entry point / overview | this README + `observability/plan.md` §1 | — |
| EO behavior + security boundary | `orchestrator-external/design.md` | core spec |
| EO ⇄ IO wire protocol | `orchestrator-external/protocol.md`, `diagram.md` | core spec |
| IO behavior + delegation | `orchestrator-internal/design.md` | core spec |
| Internal dispatch/ledger/bus | `orchestrator-internal/protocol.md` | core spec |
| Scout (reconnaissance) | `scout/README.md` → `workflow.md` → `system-prompt.md` | spec'd, harness-agnostic |
| Planning (DAG + replan) | `planning/design-notes.md` → `workflow.md` → `system-prompt.md` | spec'd, harness-agnostic |
| Build (CI failure repair) | `build/workflow.md` → `system-prompt.md` | spec'd, harness-agnostic |
| Test (verification/QA) | `test/workflow.md` → `system-prompt.md` | spec'd, harness-agnostic |
| Wire + contract schemas | `schemas/README.md` (envelope, results) | core spec (machine-checkable) |
| Observability | `observability/plan.md`; alerts in `observability/alerts.yaml`; runbooks `observability/runbooks.md` | plan (emitters not built) |
| Eval suite spec | `test-eval-spec.md` | spec'd — candidates: test + docs agents (harness/fixtures unimplemented) |
| Docs agent | `docs-agent/design.md` → `system-prompt.md` | **adopted** (implementation sequence in design) |
| Adversarial gate | `adversarial/design.md` → steel-man/contrarian prompts | **adopted** (conditional attach — criteria in design) |

## Conventions

- **Structure**: every specialist ships `workflow.md` (operational loop) + `system-prompt.md`
  (behavioral contract). On divergence between them, **the workflow wins** — file an issue.
- **Harness-agnostic tool roles** (glob, grep, read, run-build, test-edit, …) are bound per
  `workflows/bindings.md` (the binding-artifact spec: role maps, gate mechanisms, budget
  wiring, remoteless-git enforcement); the specialist docs' "Assumptions" sections carry
  the tunables (budgets, thresholds).
- **Field-name authority**: the RESULT contract table in `orchestrator-internal/protocol.md`
  and the schemas in `schemas/` use the specialists' own output-format field names; a
  specialist's fields change → its row there and its schema `$defs` entry change with them.
- **Alerts → runbooks 1:1**: every entry in `alerts.yaml` links to an anchored section in
  `observability/runbooks.md`; add both or neither.

## Version control conventions (canonical across all sections)

The ownership split is forced by the existing trust model (EO design §Security boundary
rules; sandbox network egress is restricted): **sandbox-side agents stage and commit
locally on their task branch, but never touch remotes.** The EO is the only pusher,
approval-gated; durable history is created EO-side from exported patches carrying the
same conventions as the local commits.

- **Repository structure**: single repo, trunk-based. `main` is protected: PR review
  required, no force-push, CI (`npm test` drift check + suite, `npm run check`) required
  before merge. The specification lives at the top level (`workflows/`) and follows the
  same procedures under `spec/<area>-<slug>` branches.
- **Branches**: `task/<task_ref>` — one per TASK, created by the EO at dispatch, deleted
  after merge. `hotfix/<ref>` — cut from the latest release tag for production-triage
  fixes; review is expedited, **never skipped** (the build agent's reviewer gate is
  load-bearing). `spec/<area>-<slug>` — changes to these documents.
- **Commits**: Conventional Commits — `<type>(<scope>): <subject>` (imperative, ≤72
  chars, one logical change) with footers `Task-Ref: <task_ref>` and, where a specialist
  produced the change, `Specialist: <name>`. Body explains why, not what. Committing is
  part of a repository-changing step's own done-criterion (planning §Phase 2); the
  commit — not the working tree — is the checkable end state.
- **Pull requests**: opened by the EO on a green COMPLETION (by the developer for spec
  changes). Description must state: goal, `Task-Ref`, `ledgerRef`, the test agent's
  verdict block, changed files, and — when the adversarial gate was attached — the gate
  outcome and per-iteration flaw log (from ledger DECISION entries). **SHA provenance:**
  sandbox-local SHAs (cited in specialist reports and verdict blocks) live only in the
  ephemeral task tree; the EO records the patch→durable-commit mapping in the
  description — review and audit use the durable SHAs, correlated by `Task-Ref`/
  `ledgerRef` (EO-protocol §Version control at the boundary). User-facing doc
  changes always carry review (docs-agent review table).
- **Merging & conflicts**: squash-merge (one commit per task on `main`), branch deleted
  after merge; `main` is always green. On conflict, the EO rebases the branch onto
  `main` and the affected build+test lanes re-run against the merged tree before the
  merge lands — conflicts are resolved, then re-verified, never merged blind.
  Force-push and history rewrite: never (matches build hard constraint 1).
- **Tags & releases**: annotated `vMAJOR.MINOR.PATCH` tags on `main`, cut only after
  docs-agent release notes are approved; protocol version bumps follow EO-protocol
  §Versioning. Tags are never deleted or moved.
- **Hotfixes**: branch from the latest release tag, minimal fix, same lanes and review
  gate, patch-bump; the release notes get an addendum before the hotfix tag is cut.
- **Rollback & recovery**: code — `git revert` PRs; releases — revert PR + patch
  release (tags immovable); sandbox work — void + redo from the ledger (IO design
  Stage 6); unaccepted artifacts — quarantine holds them until accepted (EO-protocol
  §Artifact custody). Every specialist whose scope overlaps these duties cites this
  section rather than restating it.

## Known follow-ups (deliberately not done here)

1. **Spec-drift CI — DONE**: `tests/spec-drift.test.ts` extracts the field tables from
   both protocol docs and asserts two-way agreement with `schemas/*.json`; it runs in
   `npm test`, names the offending token when prose and schema diverge, and is negative-
   probed (deleting a schema field fails it with a precise message). The manual
   reconciliation pass is now maintained by the check.
2. **Deterministic validator implementation — DONE**: `shared/wire.ts` compiles the
   schema files with ajv and exposes `checkEnvelope` / `checkResult` / `checkDispatch` /
   `checkLedgerEntry` — the protocol's minimal validator contract as a pure, Worker-
   bundle-safe module (`tests/wire.test.ts` pins it). New consumers adopt it instead of
   re-implementing contract checks.
3. **Observability acceptance test** (`observability/plan.md` §Implementation step 7):
   force a failure in a scratch task and reconstruct cause/latency/tokens from telemetry
   alone — blocked on the telemetry emitters (plan §Implementation steps 2–4), to be run
   once they exist.
4. **Implementation of docs-agent + adversarial gate** — adoption APPROVED; build order
   is the "Implementation sequence (approved)" section in each design doc (docs agent:
   docs CI MVP → claims index → sweep; adversarial: implement-pipeline gate first,
   then REPLAN/spec-stage). Contracts already live in the IO RESULT table, schemas,
   bindings, and the alerts inventory.