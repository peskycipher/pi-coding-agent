# Planning Agent — Design Notes and Rationale

Why the planning agent is shaped the way it is. Each adopted pattern names the research it
came from and the failure mode it prevents. Cross-references: `system-prompt.md` (behavior),
`workflow.md` (loop), companion project `../scout/` (the read-only reconnaissance stage that
can feed this planner).

## Research sources used

1. **LangChain, "Plan-and-Execute Agents" (Feb 2024)** — the three plan-and-execute
   architectures: Plan-and-Execute (planner → executor → replan node), ReWOO (variable
   binding so workers see only their needed context), LLMCompiler (DAG streaming,
   dependency-triggered scheduling; reports up to 3.7x latency speedup (and up to 6.7x
   cost savings) versus ReAct-style sequential calling).
2. **Wang et al., "Plan-and-Solve Prompting"** — the originating result that explicit
   full-task planning improves completion rates over reactive one-step reasoning (ReAct).
3. **SagaLLM (Chang & Geng, VLDB 2025)** — LLM planning fails on: unreliable
   self-validation, context loss, missing transactional safeguards, weak inter-agent
   coordination; prescribes context management + validation + transaction guarantees.
4. **ALAS (Atreja, 2025, arXiv:2508.15805)** — correction: the "ALAS (Chang & Geng, 2025)"
   paper the original draft cited does not exist; the real ALAS is Atreja's self-updating-LLM
   knowledge agent, a different subject. The findings this row described — circular
   verification, untracked state changes, costly global recomputation, and the local-repair
   solution — belong to SagaLLM (row 3). Rows 3 and 4 are one source; citations to either
   in the tables below resolve as SagaLLM.
5. **ReflAct (Kim et al., EMNLP 2025)** — reflection grounded in the agent's actual
   goal-state (world-state evidence) outperforms naive reflection-on-thoughts, which
   drifts and can trigger despair-style collapse in long-horizon tasks.
6. **RECAP (Zhang et al., NeurIPS 2025)** — long-horizon tasks need recursive,
   context-aware planning: compressed state summaries rather than raw history.
7. **Anthropic, "Building effective agents" / agent-design guidance** — composable simple
   patterns over frameworks; orchestrate via clear feedback; effort/budget tradeoffs.

## Adopted patterns and why

| Pattern (source) | Where it landed | Failure mode it prevents |
|---|---|---|
| Explicit plan-then-execute with replan decision after every observation (1, 2) | Phases 2–4; STATUS output's "→ replan decision" line | ReAct-style step myopia: optimizing one sub-problem at a time, never reasoning about the whole task; also prevents stale-state batch planning |
| Executor/planner role split (1) | Planner dispatches, never implements | Planner context polluted by implementation detail; the expensive model consulted per action |
| DAG dependency mapping + parallel groups (1 — LLMCompiler) | Phase 3; PLAN output's "parallel groups" | False serialization (slow, costly) and accidental order violations; explicit critical path |
| Variable binding across steps, context economy (1 — ReWOO) | Ledger's `output_binding`; downstream steps receive arguments + `$binding`, not history | Context loss and noise: workers drowning in irrelevant history (SagaLLM's context-loss finding) |
| Verification criterion written at plan time, validated independently at execution time (3) | Phase 2's "done when...", Phase 4's validation step; FINAL REPORT criterion→evidence table | Circular self-verification (SagaLLM): executor grading its own homework |
| Local, transactional repair with a revision log (3; see the row-4 correction — one source, SagaLLM) | Phase 4b: minimal-diff revisions, `revision_log`, re-run only downstream dependents | Small faults triggering global recomputation; untracked state changes (SagaLLM) |
| Ledger as single source of truth, restated on change, compressed not raw (5, 6) | State model; STATUS outputs restating changed rows | Context loss over long horizons; planner drifting from actual world state (ReflAct's grounded-reflection finding) |
| Commit-aware step criteria and conflict-free parallel groups (README §Version control conventions) | Phase 2 "done when" includes the local commit; Phase 3 serialization rule for shared-file steps | Merge conflicts surfacing at merge time as runtime surprises; unverifiable working-tree claims |
| User-only escalation for structural changes; local fixes handled autonomously (7) | Phase 4c thresholds; REPLAN PROPOSAL format | Both extremes: silent scope-shrink by the agent, or user pinged for every hiccup |

## Deliberately not adopted

- **Full LLMCompiler-style streaming DAG with eager scheduling:** needs infrastructure
  this design keeps harness-agnostic; the simpler ready/parallel-groups formulation gets
  most of the parallelism with none of the runtime complexity. Upgrade if wall-clock time
  of execution becomes the binding constraint.
- **Formal saga/compensation rollback (SagaLLM full transaction machinery):** requires
  instrumented side effects; a planning orchestrator over executors that report citations
  achieves the repair property via local re-dispatch instead. Adopt the full machinery if
  steps gain irreversible side effects.
- **Free-form reflective monologues (Reflexion-style):** ReflAct's evidence shows
  ungrounded reflection drifts; this design reflects only against ledger state and
  observed results, so reflection is a decision procedure, not prose.

## Open design tensions (kept, not resolved)

1. **Autonomy vs. user control:** escalation thresholds (three failures, ~80% budget,
   scope-changing revisions) are guesses; production should tune them against real runs.
2. **Ledger placement:** assumes the harness can persist a structured ledger outside the
   model context (a file, a task tool, scratchpad). If it cannot, the STATUS restatements
   carry state and the plan will drift on very long horizons.
3. **Verification depth:** "independent validation" is defined by criterion type
   (observability); some criteria (aesthetic quality, user satisfaction) cannot self-verify
   and will always need the user — the FINAL REPORT marks them rather than pretending.