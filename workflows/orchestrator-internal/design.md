# Internal Orchestrator — Design Document

The internal orchestrator (IO) manages **a single development pipeline from within its
own sandbox** (README §The two roles): it is the only agent that commands the four
specialists (`scout`, `plan`, `build`, `test`), and it is the sole writer of the team's
shared plan ledger — the blackboard. The task's purpose, the sandbox's provisioning and
destruction, and the merging of artifacts into durable history belong to the EO; the IO
runs the pipeline they enable.

## Architecture grounding

| Adopted pattern | Source | How it lands here |
|---|---|---|
| **Supervisor / hierarchical** | LangGraph multi-agent concepts: a supervisor controls all communication flow and task delegation; hierarchy = "supervisor of supervisors" | The IO is a supervisor node; the external orchestrator (EO) supervises the IO; subagents never talk to each other or to the developer — only to the IO |
| **Orchestrator-workers** | Anthropic, Building effective agents (orchestrator-workers) | The IO decomposes a task, dispatches workers as needed, and synthesizes results; workers are context-isolated specialists |
| **Subagent context compression** | Anthropic, "How we built our multi-agent research system": subagents run with their own context windows and return only distilled findings | Each specialist returns a summary + citations, not transcripts; the IO's context stays bounded |
| **Blackboard** | Hearsay-II (Erman et al. 1980); LLM-blackboard work (arXiv:2507.01701, arXiv:2510.01285) | Shared knowledge space (`ledger`) replaces pairwise chatter; specialists' results are written as structured entries and wake the next reasoning step; no control flow between workers |
| **Handoffs** | LangGraph handoff pattern: explicit destination + payload | Every delegation is a structured DISPATCH with a defined payload and an expected reply type |

## Message flow (inside the sandbox)

```
EO (outside) ⇄ IO ⇄ { scout | plan | build | test }   (each ⇄ is message protocol)
        │        │
        └── ledger (blackboard; IO is sole writer, specialists read on dispatch)
```

1. The IO receives a TASK envelope from the EO (see protocol).
2. The IO decides the sequence over the specialist roster (four live specialists;
   docs (adopted) is part of the roster; each dispatch is recorded in the
   ledger; each result arrives as a RESULT envelope and is aggregated.
3. The IO emits STATUS upward on every state change and a terminal COMPLETION or FAILURE
   envelope when the task settles.

### Delegation map (what each specialist is for)

| Specialist | Reads from task payload | Returns |
|---|---|---|
| `scout` | information need, scope | findings + citations, gaps (never raw dumps) |
| `plan` | goal, constraints, scout findings | step DAG, assumptions, done-criteria |
| `build` | current step(s) to execute | result summary, changed files, build/test commands to verify |
| `test` | code/tests to verify | pass/defect/flake verdicts + evidence |
| `docs` (adopted — workflows/docs-agent/design.md) | changed surfaces / release context | doc_updates, claims_index_delta, verdict (drift report fields per its RESULT row) |

The IO never implements, scouts, plans, or tests itself — it sequences, validates result
contracts, aggregates, and reports up. Its only tools are read-only workspace access and
specialist dispatch.

**Execution authority (reconciliation of the planner's two voices):** the planning
specialist's documents describe two modes, and this paragraph fixes which applies.
**In-suite** — the mode of this document — `plan` is a contract producer: it runs Phases
1–3 of its own workflow (intake, decomposition, sequencing) and returns the step DAG;
the IO owns the replan decision, dispatch, and monitoring (their Stages 3–5 here). The
planner's Phases 4–5 (execution monitoring, final validation) apply **only in standalone
single-agent mode**, where the planner itself is the orchestrator and no IO exists. Any
text in the planning docs that reads as if the planner dispatches executors or monitors
execution is standalone-mode text.

## Lifecycle stages

### Stage 1 — Task intake and interpretation
On TASK: validate envelope, restate goal in one line, inventory constraints and the
sandbox profile (see "Sandbox constraints"), decide whether the task is answerable from
ledger state (idempotent re-ask) or needs a fresh sequence. Ambiguity that changes the
sequence is routed up as CLARIFICATION, not guessed.

**Spec intake (when TASK carries `session.specRef`):** apply the EO design's **Spec
completeness checklist — Gate 3, verbatim** (orchestrator-external/design.md
§Spec completeness checklist: the same eight checks, one shared artifact). A spec that
fails intake is FAILURE class `spec-invalid` with `recoveryOptions: [revise-spec,
clarify]`; the partial ledger state (if any) and the failing checks are attached as
evidence. Also verify the mounted spec's SHA matches the SHA the TASK records (protocol
§Session input artifacts) — an unapproved spec version arriving is `spec-invalid`
evidence too. The pipeline never improvises around an ambiguous or unapproved spec.

### Stage 2 — Delegation planning
Choose the pipeline shape over the specialist roster (four live, five with docs on
adoption). Canonical shapes:

- `research`: scout (+ plan if the user wants a plan, not a result) — read-only chain.
- `implement`: scout → plan → [approval] → build → test.
- `verify-only`: test (given a target SHA/branch).
- `resume`: continue an interrupted ledger (Stage 6 recovery).

Steps get dependency order (e.g., `build` needs `plan`'s step or an explicit target;
`test` needs `build`'s changed-files). Parallel dispatch only where the DAG allows —
scout probes may fan out; build/test do not run concurrently on the same tree.

### Stage 3 — Dispatch and monitoring
Send DISPATCH envelopes with bounded payloads; track per-specialist budget (tool calls,
wall time) and the task-level budget from TASK (`budget.wall_clock_task`/
`tokens_task`) — mark STATUS `budget_pressure: true` at ≥80% and stop opening new
dispatches at 100%, settling at the next clean state (EO-protocol §Budget semantics). Dispatch payloads
that will mutate the tree carry the git context (the EO-designated branch —
`task/<task_ref>`, or a `hotfix/<ref>` branch when the task triages a release per
README §Hotfixes — plus base SHA); specialists commit locally per the README's VC
conventions so each step's diff is attributable and reviewable before the EO exports it.
On TIMEOUT/FAILURE from a specialist: one retry with a re-formed payload; second failure
routes by lane. Degraded-pipeline criteria ("without scout, if possible" means exactly:
the pipeline may proceed without scout only if the task's own goal/constraints do not
depend on scout findings — e.g. a `verify-only` shape targeting an explicit SHA; any
`implement`-shaped pipeline needs plan inputs that scout findings feed, so it fails
upward with partial ledger state instead). plan/build/test failures → Stage 5.

### Stage 4 — Aggregation
Validate each result against its expected contract (scout: citations present; plan: DAG +
done-criteria; build: changed-file list + verification commands; test: verdict + evidence).
Validation is two-layered: required-field presence and shape are machine-checked against
`workflows/schemas/results.schema.json` (deterministic; no model judgment), semantic
validity (does the citation exist, is the DAG acyclic) is the IO's judgment — schema
failure short-circuits before the semantic layer and counts as specialist failure.
Aggregate only contract-valid results.
Merge into the task-level state and ledger.

### Stage 5 — Failure, retry, ambiguity
- Specialist failure: 1 re-formed retry → if unrecoverable, FAIL upward with partial
  ledger state and the specialist evidence; never fabricate a missing result.
- Conflicting specialist results (e.g., test says defect where build claims done): treat
  verification as authoritative (test > build), record the conflict, and act on it.
- Ambiguity discovered mid-sequence that changes goals/scope: stop the pipeline at the
  next clean state (never mid-build), and request clarification upward.

### Stage 6 — Interruption and recovery
The sandbox may be torn down or restarted at any point. All durable state lives in the
ledger, which the EO can persist across sessions. On restart: read ledger, recompute
which records are stale (ephemeral FS — results referencing dead paths are voided, not
trusted), and resume the pipeline from the first unfinished stage. Local commits die
with the ephemeral tree: redo re-dispatch applies the same conventional-commit
expectations (README §Version control conventions), and the durable record of any
already-exported work is the EO-side applied patch — it is never recreated by replaying
sandbox-side history.

## Sandbox constraints

| Constraint | Design consequence |
|---|---|
| Limited network egress | Subagents' web tools are untrusted-availability; scout prefers workspace sources; the IO flags web-dependent results as `network-unverified`. Bulk external fetches route up as ARTIFACT_REQUEST to the EO instead of direct egress |
| No remote git access | The sandbox commits locally on `task/<task_ref>` only; the EO mediates all branches, PRs, merges, and tags (README §Version control conventions). Specialists' git tool roles (`git-info`, local commit) are local-only by construction |
| Ephemeral filesystem | Nothing durably important lives outside the ledger; artifacts to be kept are exported via ARTIFACT_TRANSFER before teardown; restarts void dead-path references |
| Isolated tooling | The tool inventory is declared per sandbox; the IO validates each specialist requires-tools subset against the profile at dispatch, not at boot promise |
| Context limits | The IO's own context is guarded: specialists return compressed results; ledger entries are summaries, never transcripts; full transcripts stay inside each specialist's session |

## Sources

- LangGraph multi-agent concepts — supervisor/hierarchical architectures, handoffs
  (destination + payload), when multi-agent: modularity/specialization/control.
- Anthropic — "Building effective agents" (orchestrator-workers; evaluator pattern for
  verification).
- Anthropic — "How we built our multi-agent research system" (subagent context
  compression, parallel workers, lead-agent delegation).
- Erman et al., Hearsay-II (1980); Han & Zhang, arXiv:2507.01701; Salemi et al.,
  arXiv:2510.01285 — blackboard: shared knowledge space as the coordination substrate.
- Companion specs: `protocol.md` (wire format), `system-prompt.md` (behavior),
  sibling agents in `workflows/scout|planning|build|test` (specialist system prompts).