# Adversarial Review Pipeline — Steel-Man → Contrarian

A quality-gate pipeline for proposals: a **steel-man** agent presents a proposal in its
strongest form (preempting objections, strengthening weak points, stating premises
explicitly), then a **contrarian** agent attacks only that strengthened version and returns
a strictly binary verdict — APPROVED, or REJECTED with the fatal flaws listed. On REJECTED,
the proposal is revised and the loop repeats under a hard iteration cap.

## The design insight (preserved everywhere below)

The quality gain comes from making the model **argue with itself productively**, not from
making it smarter. Agent reliability in 2026 is mostly an orchestration problem, not a
capability problem: a single agent with no adversarial check is a Yes-Man. The contrarian's
job is to be adversarial against the **best case**, not the naive case — which is why it
receives only the steel-man output and never the original draft.

## Why the pipeline exists (grounding)

| Claim | Source |
|---|---|
| LLMs carry a strong agreement prior; multi-agent groups without an adversarial role converge on the first plausible answer | Sharma et al., *Towards Understanding Sycophancy in Language Models* (Anthropic, 2023) — RLHF-adjacent tuning rewards agreement over correctness |
| Structured critique is cheaper than open-ended re-generation; small fast models suffice for the contrarian role | the critique is bounded and verdict-shaped — classification, not creation — so Haiku/GPT-4o-mini/Flash-class models perform it well (the pattern the observability plan already exploits with classifiers). Validate the model per capability: deepseek-v4.1-flash returned empty verdict-only turns in the acceptance run while glm-5.3-flash answered — see observability plan §Trade-offs, failure mode 1 (the incident note) |
| Adversarial review surfaces hidden assumptions by forcing premises into the open | steel-man step = premise elicitation; the contrarian then attacks *targets*, not vibes — the same citations-or-drop discipline as the test agent's verdicts |
| Devil's-advocate roles work when institutionalized, not ad hoc | classic small-group research (Nemeth): appointed dissent changes outcomes; random dissent gets absorbed |

## Architecture and message flow

```
proposal (from plan / REPLAN / any proponent)
   → IO: DISPATCH steel-man(proposal)          1 outstanding, bounded payload
   → steel-man RESULT: strengthened proposal + explicit premises + preempted objections
   → IO: DISPATCH contrarian(strengthened output ONLY)
   → contrarian RESULT: APPROVED | REJECTED{fatal_flaws[]}
        APPROVED  → pipeline resumes (gate passed; ledger DECISION entry)
        REJECTED  → revision owner applies fatal flaws → loop, iteration + 1
        iteration_cap (default 3) hit → escalate upward with best-case + flaw list
```

**Two rules that make it work:**

1. **Information asymmetry is intentional.** The contrarian's dispatch payload contains
   only the steel-man RESULT — never the original proposal, never prior iteration history.
   Attacking the best case is the entire yield; handing it the naive draft hands it a
   straw-man target.
2. **Strict separation of verdict and repair.** The contrarian never revises; the steel-man
   never defends; revision belongs to the proposal's owner (plan specialist on plans, the
   proponent otherwise). Role-confusion is the failure mode that turns adversarial review
   into consensus theater.

## Where it plugs into the suite

- **Deployment model (both gates, one pair of agents):** steel-man and contrarian are
  *text-in/text-out* agents — the contrarian needs near-zero tools and the steel-man works
  only on its payload — so they run at two locations without provisioning differences:
  **EO-side** at spec approval (a two-model check before any sandbox exists, dispatch
  payloads carry the spec artifact content) and **IO-side** in the pipeline and on
  structural REPLANs. The RESULT contract, iteration cap, and ledger DECISION entries are
  identical in both locations.
- **Attach criteria** (the IO/EO applies these mechanically rather than by vibe): attach
  when ANY holds — (1) the spec's boundaries include publish-shaped or irreversible
  actions; (2) `route.mode: parallel` (interface contracts are the fragile surface);
  (3) the capability map has ≥3 modules; (4) a prior iteration of the same proposal was
  rejected in the last 7 days. Otherwise the gate is skipped and the skip is ledgered
  (`DECISION, kind: gate_skipped, reason`). The skip itself is visible — silent
  non-attachment is a drift-class failure.
- **Attach point:** EO-side at spec approval (§Idea-to-specification intake, optional
  quality gate); IO-side in the pipeline shape `implement`, between `plan` and the
  `[approval] → build` branch, and on any REPLAN that would change scope.
- **Loop ownership:** on REJECTED, the IO re-dispatches `plan` with the fatal flaws in
  the dispatch payload (`input.fatal_flaws`); the planner's repair addresses the named
  flaws and nothing else (steel-man edge case), and the same three-failures-per-step
  escalation thresholds apply — the gate loop cannot outlive the plan's escalation
  rules.
- **EO boundary interaction:** the approval gate and this pipeline compose — the
  developer approves the *surviving* best case, with the contrarian's iteration history
  visible in the DECISION REQUEST context. The same requirement carries into version
  control: when the gate was attached, the EO's PR description must include the gate
  outcome and the per-iteration flaw log (from ledger DECISION entries) — a reviewer
  sees not only what passed, but what it survived and what was fixed between rounds
  (README §Version control conventions §Pull requests). Approval gates stay the EO's;
  the pipeline gates quality, not authority.
- **Ledger:** each iteration appends a `DECISION` entry (`kind: decision, ref: <iteration
  n>`, verdict + fatal flaws compressed). The revision_log links which flaws were addressed
  in the next iteration — an unaddressed REJECTED flaw in iteration n+1 is a contract
  violation of the revision.
- **Observability** (`workflows/observability/plan.md`): new signal —
  `agent_loop_iterations_total{gate="adversarial"}`; a task hitting the cap should trend
  toward the escalation alert, and REJECTED-flaw recurrence (same flaw across iterations)
  is the ticket-severity anomaly that says the loop is thrashing, not converging.

## The loop protocol (state machine)

```
state: iteration = 0
loop while iteration < ITERATION_CAP (default 3):
    steel-man RESULT = strengthen(proposal)
    verdict = contrarian(steel-man output)
    APPROVED → exit gate-passed
    REJECTED(fatal_flaws) → proposal = revise(proposal, fatal_flaws); iteration += 1
exit gate-capped → escalate: best case + accumulated flaw list + what was addressed per iteration
```

Budget per iteration: steel-man and contrarian each get small budgets (default 10 tool
calls / 120 s; the contrarian needs near-zero tools — it critiques arguments, not
workspaces). Whole-gate cap: `iteration_cap × (steel-man + contrarian)` model calls, by
design the cheapest adversarial insurance in the suite.

## Trade-offs and risks

1. **False rejections stall healthy plans** — a contrarian that always finds something
   fatal turns the gate into a doom loop; the cap plus "fatal = would break the objective
   or its constraints, stated as a falsifiable claim" (contrarian prompt) bounds this.
   If rejection rate stays > ~50% across tasks, the gate is misattached or the proponent
   loop is thrashing — the ticket alert exists for exactly this.
2. **Anchoring cascade** — iterating steel-man on its own strengthening can drift the
   proposal away from the original intent. Mitigation: each steel-man dispatch carries the
   original goal and constraints; the IO validates the strengthened version still targets
   the same goal (a cheap contract check) before dispatching the contrarian.
3. **Contrarian capture by politeness** — the known failure: the adversarial role softens
   under the same agreement prior it exists to fight. Mitigations, in order: strict binary
   output (no hedged verdicts available), the acknowledgment clause (it must name the best
   case it is attacking), and a small non-frontier model (frontier models are better at
   being agreeable, which is the bug, not the feature, here).
4. **Iteration-cap gaming** — proponents writing proposals that barely pass rather than
   ones worth passing. Mitigation: APPROVED verdicts include the premises the proposal
   survived on; recurring weak premises across APPROVED plans is itself an observable.
5. **Cost doubling is not free** — two extra calls per gate. That is the point of the cap:
   bounded to a small multiple of one planning call, versus the unbounded cost of building
   on an unchallenged wrong plan.
6. **The gate is advisory to authority** — APPROVED does not mean shipped. EO approval
   gates (irreversibility, scope) apply regardless of verdict; the pipeline improves the
   quality of what a human approves, it does not replace the human.

## Implementation sequence (approved)

Build order after adoption approval — sequence retained from the original adoption plan:

1. Attach after `plan` on implement-shaped tasks (the highest-stakes proposal in the
   suite); run in scratch tasks first and measure rejection rate before trusting APPROVEDs.
2. Extend to REPLAN proposals and research conclusions (scout handoffs with `next_stage:
   report-to-user`).
3. Tune `ITERATION_CAP` and the contrarian's model tier against the loop-iteration metric.