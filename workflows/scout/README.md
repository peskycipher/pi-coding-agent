# Scout Agent — README

A production-ready scout agent: a lightweight, **read-only** reconnaissance sub-agent that
explores, gathers, evaluates, and reports information for one objective — so the consuming
agent (the IO in the suite; a main agent when run standalone) never sees raw, unfiltered
sources. In the suite it is the first specialist of **scout → plan → build → test**, each
in its own context (the standalone chain form — scout → implementer → verifier — is
labeled where the suite is not present).

## Files

- `workflow.md` — triggers, stage-by-stage process, tool rules, quality checks,
  failure/retry handling, stop conditions, and the handoff contract. Operational logic.
- `system-prompt.md` — the agent's production system prompt: identity, responsibilities,
  scope boundaries, tool rules, decision guidance, verification habits, escalation, output
  contract, edge cases. Behavioral logic.

## How they fit together

```
Orchestrator (the IO in-suite; a main agent/user standalone)
   │  objective + budget + constraints
   ▼
[Stage 0: intake → probes]  ── no tools, planning only
[Stage 1: parallel sweep]   ── glob / grep / web-search
[Stage 2: deep reads]       ── one read per promising candidate
[Stage 3: evaluate+verify]  ── INCLUDE / EXCLUDE / INCLUDE-WITH-SUMMARY, citations
[Stage 4: compress]         ── ≤5-line summaries, identifiers preserved
[Stage 5: report]           ── contract output → orchestrator routes next stage
```

The workflow governs **how the scout runs** (loop, budgets, retries, stops). The system
prompt governs **what the scout is and decides** (boundaries, verdicts, verify habits,
report format). Install both: instantiate a subagent with the system prompt and drive it
with the workflow's stages and handoff contract. When adapting to a new harness, bind the
documented tool *roles* (glob, grep, read, web-search) to that harness's real tools per
`workflows/bindings.md` and keep everything else intact.

## Key design decisions and their sources

| Decision | Why | Source |
|---|---|---|
| Read-only agent, explicit hard boundaries | Gate-worthy actions (writes, external sends) belong to dedicated gated surfaces, not a broad scout; a scout mid-chain must never mutate state — git included, since durable history is created at the EO boundary | Anthropic, "Writing effective tools for agents" |
| Simple loop, no framework | Composable single-worker pattern beats complex frameworks; the loop is: probes → reads → verdicts → report | Anthropic, "Building effective agents" |
| Verdict-based filtering (INCLUDE/EXCLUDE/INCLUDE-WITH-SUMMARY) | Context pre-screening: downstream agents get curated, token-light input; behavior stays predictable as retrieval varies | Scout-pattern writeups (context pre-screening for agents, e.g. MindStudio's scout-pattern article) |
| Findings require citations; citation you cannot produce = finding dropped | Anti-hallucination by contract, not hope | Anthropic system-prompt patterns ("every finding includes file:line") |
| Two-source rule for plan-changing findings | Single-source claims get a flag, not silence; secondary claims never presented as fact | Standard verification practice for eval-grade agents |
| Compression at handoff (≤5 lines, identifiers preserved) | The consumer must act without re-reading sources — that is the entire token-efficiency point of the pattern | Scout-pattern writeups (compressed findings-for-handoff subagent examples, e.g. the pi scout agent) |
| Explicit budgets + saturation stop condition | Lower effort → fewer, more-consolidated calls; correctness still matters more than cost | Anthropic agent-design (effort tradeoff, evals guidance) |
| Deterministic handoff contract (JSON shape) | Chaining stays predictable; orchestrator route rules are mechanical, not improvised | Anthropic agent-design (clear feedback/composable patterns) |

## Assumptions to confirm or correct

1. **Target harness:** written harness-agnostic with tool *roles*. Confirm the actual
   runtime (pi subagent via herdr, Claude Agent SDK, OpenAI Agents SDK, other) so roles
   can be bound to real tool names.
2. **Fresh-context consumers:** assumes downstream agents start clean contexts
   (subagents/child sessions). If they share the orchestrator's context, the compression
   step buys little and should be dropped.
3. **Budget defaults:** 15 tool calls, ≤5-line summaries — defaults, not truth. Confirm
   typical objectives need more or fewer.
4. **Source trust order** (docs > repo code > primary web > secondary web) assumes a
   coding/workspace context. A research-only scout may rank web higher.
5. **Single-objective input:** the workflow requires one bounded objective per run and
   returns split proposals otherwise. Confirm the orchestrator handles re-dispatch.
6. **Write needs stop the scout:** any discovered need to mutate state escalates rather
   than executes. Confirm no use case legitimately requires a writing scout.