# Scout Agent — Agentic Workflow

The operational loop that drives the scout defined in `system-prompt.md`. Written against
Anthropic's guidance on agent design: a composable read-only worker in a loop with clear
feedback, explicit budgets, and a deterministic handoff to the next stage of the chain
(typically: scout → implementer → verifier, each on a fresh context).

Harness-agnostic tool roles used here: **glob** (index/list), **grep** (text search),
**read** (file/URL reader), **web-search**. Bind them to your runtime's equivalents per
`workflows/bindings.md`.

---

## Trigger conditions

Run the scout when any of these holds:

1. **Context pre-screen:** the main agent is about to start a task whose context would
   exceed ~30% of its window if raw sources were included.
2. **Cold start:** a task references domains, files, or APIs nobody has summarized yet in
   this session.
3. **Fresh-context check:** a verifier needs unbiased evidence after an implementation
   change (no implementation bias in its inputs).
4. **Staleness sweep:** a previous scout report is older than the sources it cites are
   likely to be (config/docs churn, active development).
5. **Explicit request:** the user or an orchestrator hands over a scoping objective.

Do **not** run the scout when: the answer is already in the orchestrator's context; the
question is a one-line lookup cheap enough to do inline; or the objective requires
write/implement actions (route to an implementer instead).

## Inputs

| Field | Required | Notes |
|---|---|---|
| `objective` | yes | One bounded question/area. Not multi-objective — split those. |
| `budget` | no | Tool-call cap and/or token cap. Default: 15 tool calls. |
| `constraints` | no | Paths/dirs to search, sources to ignore, deadlines, freshness needs. |
| `expected_consumer` | no | `implementer` / `verifier` / `user` — shapes compression depth. |

## Stage-by-stage process

### Stage 0 — Objective intake (no tools)
- Restate the objective in one line. If it is multi-objective, return it split into
  sub-objectives with a recommendation on order, and stop.
- Identify the 2-4 entities that a search can find: symbols, filenames, endpoints,
  doc topics, error strings.
- Output: probe list (the only planning artifact; no prose plan).

### Stage 1 — Broad sweep (parallel, cheap tools)
- Fire all independent glob/grep/web-search probes in parallel.
- Collect candidate list with zero-trust metadata: where found, how recently modified.

### Stage 2 — Deep read (sequential by priority)
- Read only candidates whose sweep metadata looks promising. One read per candidate.
- Stop reading a source the moment it stops bearing on the objective.

### Stage 3 — Evaluate and verify
- Issue INCLUDE / EXCLUDE / INCLUDE-WITH-SUMMARY per the system prompt's decision rules.
- For each INCLUDE: locate citation (path:line / URL+date); apply the two-source rule for
  plan-changing findings; deduplicate overlapping evidence, keeping the best citation.

### Stage 4 — Compress
- Summarize each INCLUDE-WITH-SUMMARY to ≤5 lines, preserving exact identifiers and
  citations. The consumer must be able to act without re-reading the source.

### Stage 5 — Report and hand off
- Emit the system prompt's contract output (Objective / Verdicts / Findings / Gaps /
  Handoff). Return to the orchestrator; never contact downstream agents yourself.

## Tool usage rules

- Parallel-safe tools first (glob, grep, web-search may batch); **read** is the only
  sequential gate where judgment happens per source.
- Every probe must be attributable to a Stage-0 entity. No speculative tool spam.
- Retry policy per tool call: one retry with a reformed query (broader term, alternate
  location, different role) — after that the source is marked unreachable in Gaps.
- Hard-stop the loop when budget is reached; quality over completeness.
- Version control: the scout never commits, branches, or tags (read-only to git).
  Where the objective concerns moving code, the verdict metadata records the
  branch-sensitivity of what was found, so stale citations are detectable downstream
  (README §Version control conventions).

## Quality checks (before emitting the report)

1. Every finding has a citation — none missing, none fabricated.
2. Every candidate in the sweep has a verdict; nothing silently dropped.
3. Compression preserved identifiers and no summary changed a claim's meaning.
4. Gaps section names what was NOT found and what was tried — non-empty when signal was thin.
5. Handoff payload is self-contained: the consumer needs no follow-up questions to start.
6. Total output is smaller than the raw material would have been — or it should have been
   INCLUDE-only with no summaries.

## Failure and retry handling

| Failure | First response | Second response | Then |
|---|---|---|---|
| Probe returns nothing | Re-formulate query (synonym, broader scope) | Different tool role on same entity | Mark unreachable in Gaps |
| Source read fails | Retry once | Equivalent source (cache, mirror, git history) | Mark unreachable in Gaps |
| Conflicting evidence | Rank by source trust, report both | Escalate only if plan-changing | "conflict" flag on both |
| Budget exhausted mid-stage | Stop tool calls, emit best-so-far | — | State budget exhaustion in Handoff |
| Ambiguous objective | Continue with best interpretation | — | Name ambiguity in Gaps |
| Write/reachability needed | Stop immediately | — | Escalate with partial report |

## Stop conditions

Stop scouting (successfully or not) when ANY of these is true:

1. The objective is answerable from collected evidence — stop searching, start reporting.
2. Consecutive probes return no new signal (saturation) — diminishing returns achieved.
3. Budget reached (tool calls or tokens).
4. A hard blocker hit (write access needed, unreachable everything, ambiguity needing the
   orchestrator before further probes would be meaningful).

There is no "run until perfect" — the scout's product is a decision-grade report, not
exhaustive research.

## Handoff contract

The scout hands the following object to the IO (consumed by the IO per the RESULT
contract table; validated against `schemas/results.schema.json`, specialist `scout`):

```
{
  objective: "<one line>",
  verdict_stats: { included: N, summarized: N, excluded: N, unreachable: N },
  verdicts: [ { candidate, verdict: "include" | "exclude" | "include-with-summary", why } ... ],
  findings: [ { claim, citation, confidence, phase: "final" | "conflict" } ... ],
  gaps: [ "<unresolved question + what was tried>" ... ],
  handoff: {
    next_stage: "implement" | "verify" | "re-scout" | "report-to-user",
    payload: "<minimal self-contained facts; implementer/verifier needs nothing else>"
  }
}
```

Routing rules for the IO: `implement` when findings define the change; `verify`
when findings check existing behavior; `re-scout` when gaps block the plan and sharper
probes exist; `report-to-user` when the objective was itself a research question.

## Assumptions

- The harness supports parallel tool calls for read-only tools and a budget mechanism
  (or the model is trusted to self-limit per the prompt default).
- Downstream agents start with fresh context (subagents/child sessions), which is what
  makes the compression work worthwhile.
- Web access exists but is not assumed primary: workspace sources outrank web ones.