# Planning Agent — Agentic Workflow

The operating loop for the planning agent defined in `system-prompt.md`. It follows the
plan-and-execute architecture (LangChain/LangGraph): an explicit planner separated from
execution, a re-plan decision after every observed step, and a dependency-tracked task DAG
(LLMCompiler-style) with transactional, local-first repair (SagaLLM-style). The agent
plans, monitors, revises, and validates — it does not implement steps itself; each step is
handed to an executor (worker agent or user) and observed.

Harness-agnostic. Tool roles: **read** (files/URLs), **glob/grep** (workspace search),
**web-search**, **dispatch** (send a step to an executor agent and await its result).
Bindings per `workflows/bindings.md`; in-suite, `dispatch` belongs to the IO (see the
execution-authority reconciliation in orchestrator-internal/design.md).

---

## State model (the source of truth)

The plan ledger — not the conversation history — is authoritative. All six phases read and
write this ledger.

```
goal:        <one line, verbatim from the user + clarified contract>
assumptions: [ { id, statement, status: unverified | verified | invalidated } ]
steps:       [ { id, action, tool_role, depends_on: [step ids], output_binding,
                 status: pending | ready | in_progress | done | failed | blocked,
                 result_summary, citation_of_result } ]
revision_log:[ { timestamp, trigger, change (steps added/moved/removed), affected steps } ]
final_report: null | { validated: bool, checks: [...], artifacts: [...] }
```

State rules:
- Every status change, assumption change, and revision is written to the ledger first,
  narrated second.
- Step outputs are stored as compressed summaries with citations (path:line / URL /
  executor result), bound to `output_binding` names that later steps reference as
  `$binding` — a downstream step's prompt contains only its arguments and bound variables,
  never the full history (ReWOO context economy).
- The ledger is restated (in tabular form) whenever it changes or the user asks.

## Phase 1 — Goal intake and clarification

**Tool rules:** read/glob/grep/web-search allowed for grounding assumptions; no dispatch.

**Process:**
1. Restate the goal in one line. List the constraints given vs implied.
2. Inventory assumptions as ledger entries (`unverified`). Verify cheap ones immediately
   with read-only tools; expensive ones stay flagged for the user.
3. Decide the clarification set — ask the user ONLY about: scope boundaries, done-criteria
   ("what does finished look like"), and irreversible/action-requiring constraints.
   Everything else is an assumption written into the ledger, not a question.

**Decision point:** goal actionable now?
- Yes → Phase 2.
- Ambiguous in a way that changes the plan structure → output Clarification Request
  (format below) and STOP this phase until answered.

**Error handling:** if grounding tools fail or return nothing, proceed with flagged
assumptions; never block intake on verification.

## Phase 2 — Task decomposition

**Tool rules:** read-only tools allowed to inspect relevant code/docs; no dispatch.

**Process:**
1. Decompose the goal into steps that are each: (a) delegable to an executor in one
   bounded turn, (b) verifiable (has a checkable end state), (c) small enough that
   failing it does not sink the plan. For steps that change the repository, the
   checkable end state is a **commit**, not a working tree: "done when" includes the
   locally committed change on `task/<task_ref>` with a conventional message and
   `Task-Ref` footer (README §Version control conventions).
2. Write each step with: action (imperative, one sentence), tool_role needed,
   verification criterion ("done when..."), and its output_binding name.
3. Cap: decompose to the fewest steps that fully cover the goal. A step that cannot be
   verified is split or merged until every step can be checked.

**Decision point:** decomposition granularity — target 3–12 steps. More signals the goal
was actually multiple goals: split and re-clarify.

**Error handling:** if a step cannot be given a verification criterion, mark the plan
"draft" and surface that step in the plan output for user confirmation before Phase 3.

## Phase 3 — Sequencing and dependency mapping

**Tool rules:** no tools required; read-only lookups allowed to confirm ordering facts
(e.g., config must exist before build).

**Process:**
1. Build the DAG: each step lists `depends_on`. No cycles — a detected cycle is a
   decomposition error; re-split the involved steps.
2. Mark steps with no unmet dependencies as `ready`.
3. Identify parallelizable groups (independent `ready` steps) for concurrent dispatch.
   **Independent means conflict-free:** steps in the same parallel group must not touch
   the same files. Where the DAG allows concurrency but files overlap, the group is
   serialized — merge conflicts are planning errors, not runtime surprises (they are
   resolved EO-side by rebase + lane re-runs, README §Merging & conflicts).
4. Order critical-path steps; annotate any step whose failure invalidates others'
   preconditions.

**Decision point:** execution mode per group — parallel dispatch for independent steps;
serial for dependent chains.

**Error handling:** if dependencies are genuinely circular, the goal needs an intermediate
artifact (interface, stub, spec) — insert it as a new step and re-map.

## Phase 4 — Execution monitoring (standalone mode)

**In-suite, this phase's duties belong to the IO** (orchestrator-internal/design.md,
Stages 3–5): the planner returns the step DAG and does not dispatch or monitor — see the
execution-authority reconciliation there. The loop below applies when the planner runs
standalone, as the single-agent orchestrator.

**Tool rules:** dispatch for executors; read/glob/grep to spot-check executor claims;
web-search only to resolve contradictions a spot-check cannot.

**Process (the replan loop):
1. Dispatch all `ready` steps. On each result:
   - Validate the result AGAINST THE STEP'S VERIFICATION CRITERION — independent
     validation, not a judgment call by the executor's own claims (a step is `done` only
     when the criterion is observably met).
   - Spot-check executor outputs against reality before trusting them (read the changed
     file, run the read-only check). An executor's "done" is a claim, not a fact.
2. Update the ledger: status, result_summary, citation.
3. **Replan decision after every observation** (LangGraph replan node):

| Observation | Action |
|---|---|
| Step done, dependencies unblocked | Mark dependents `ready`; continue |
| Step done, no pending steps | Phase 5 |
| Step failed, cause localized | Local repair: retry once, or re-dispatch a revised step; re-run only steps downstream of the changed output |
| Step failed, invalidated an assumption | Invalidate assumption in ledger; Phase 4b replan revision |
| User changed goal/constraints | Phase 4b — full structural replan |
| Two consecutive replan revisions touch the same step | Escalate (see Phase 4c) |

4b. **Replan revision:** re-run Phase 2–3 only for the affected subgraph. Never
   re-decompose the whole plan for a local failure — add, replace, or re-order the minimal
   set of steps. Log every change in `revision_log`.
4c. **Escalate when:** three failures on the same step; a replan would change scope, not
   just steps; cost/budget limits approached; an invalidated assumption removes the
   foundation of the plan. Output Replan Proposal (format below) for the user.

## Phase 5 — Final validation (standalone mode; in-suite the IO aggregates)

**Tool rules:** read/glob/grep for checks; no dispatch.

**Process:**
1. Walk the goal's done-criteria one by one; for each, name the evidence (artifact,
   citation, check) that shows it is met.
2. Re-verify invalidated-assumption replacements: what replaced them, why sufficient.
3. Confirm the ledger is coherent: no step marked done without citation; no assumption
   unverified at report time.
4. Emit Final Report (format below). If any criterion lacks evidence, the report says
   exactly which and why — a plan is not "complete", it is "complete except X".

**Decision point:** validated?
- All criteria evidenced → final report with `validated: true`.
- Gaps → next-step recommendations, or a re-specified goal for a fresh run.

## Stop conditions

1. All steps done and validated → final report.
2. Escalation threshold hit (4c) → replan proposal, awaiting user.
3. Clarification required → clarification request, awaiting user.
4. Budget exhausted → status report: what is done/cited, what remains, options.
5. Goal fulfilled early (steps became unnecessary) → prune via revision_log, validate
   against done-criteria, report.

Planning has no "keep going until it looks done" — every stop is one of the five above,
named in the output.