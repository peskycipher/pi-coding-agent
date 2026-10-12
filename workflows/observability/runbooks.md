# Suite Runbooks

One section per alert defined in `alerts.yaml`. Every section follows the same three-line
format: what it means / first check / who decides. Anchors are the alert names, exactly as
referenced from `alerts.yaml`. Page alerts are the closed set from the observability plan;
ticket alerts arrive in the daily digest and get treated with the same discipline.

# task_failure_unrecoverable

**Means:** a task settled to FAILURE and no automated lane or retry budget remains — a human decides next.
**First check:** open the run report (`jq 'select(.event=="result_received")' ~/.agent-suite/logs/<trace_id>.jsonl`) → failing step, classification, attempts already spent. Then open the Langfuse trace for `trace_id = <task_ref>` to see which specialist span failed last and why.
**Escalate to:** the owning developer. Choose recovery: resume (new TASK with `resume: <ledgerRef>`), re-dispatch the failed specialist with a revised payload, or revise scope.

# pipeline_stalled

**Means:** the IO has not sent a STATUS for >300 s with dispatches outstanding — sandbox death, channel drop, or a wedged specialist. (The heartbeat is the IO's periodic no-change STATUS; specialists do not emit heartbeats — their silence shows up as a stalled pipeline.)
**First check:** `agent_heartbeat_age_seconds` trend and the last STATUS frame in the task JSONL. If the sandbox is alive, the last DISPATCH (Langfuse span) shows the specialist that stopped responding.
**Escalate to:** if the sandbox is dead, EO sends INTERRUPT(reason: user), exports ledger per protocol teardown semantics, and re-dispatches on a fresh sandbox from the last ledger entry.

# completion_gate_rejected

**Means:** the IO reports done but its report is missing required fields (summary, verdictAttenuations, artifactRefs, ledgerRef) — a specialist contract violation reaching the terminal stage.
**First check:** which fields were missing (EO NAK payload `error`), then the corresponding specialist RESULT contract in `workflows/orchestrator-internal/protocol.md` (machine-checked form: `workflows/schemas/results.schema.json`) — the violation is upstream of the IO.
**Escalate to:** re-dispatch the offending specialist with the contract field named in the NAK; if it repeats, file the contract-violation ticket (this runbook and that ticket share the same root cause most of the time).

# nak_loop

**Means:** the two sides are speaking different protocol versions or malformed payloads — the frame validator is saving you; the loop is the symptom.
**First check:** `jq` the NAK frames (`error`, `receivedType`) from the task JSONL; diff the frames against `workflows/schemas/envelope.schema.json` (the machine-checkable form of the protocol tables); check `v` values on both sides.
**Escalate to:** halt the session per the EO prompt's two-NAK rule, fix the emitter, restart. If the spec itself is ambiguous, open a `spec/` PR naming the ambiguity against both protocol docs (README §Version control conventions) — that is how the last drift audit's fixes got written.

# contract_violation_rate

**Means:** more than 20% of dispatches in the last hour returned results failing their RESULT contract — a specialist is producing structurally garbage output (wrong shape, missing required fields), not just failing.
**First check:** `agent_contract_violations_total{specialist}` over the window and the `contract_violation{fields_missing}` log events — which specialist, which fields, one model burst or steady state? Cross-check the Langfuse trace for a malformed dispatch payload (garbage in, garbage out).
**Escalate to:** the developer digest. Likely causes in order: a protocol/schema change shipped out of sync, a model change on one specialist, or a new payload shape the specialist prompt never covered. Fix the emitter or re-prompt; do not widen the contract to make the signal go away.

# retry_rate_anomaly

**Means:** an agent's retry count is >2x its trailing 7-day baseline — the environment or an upstream input changed, even if tasks still eventually settle.
**First check:** `agent_retry_total{agent, lane}` for the offender; group the retried task_refs by failing stage and classification. A single lane spiking (`infra-outage`, `environment`) is usually an environment regression, not agent behavior.
**Escalate to:** the developer digest with the dominant lane + exemplar trace. Environment regressions get fixed at the environment; persistent `re-formed payload` retries on a specialist get its dispatch contract examined.

# token_burn_anomaly

**Means:** per-turn p95 tokens for one agent are >3x their 30-day baseline — something is inflating inputs (ledger bloat, a payload missing compression) before anything looks slow.
**First check:** Langfuse prompt/completion breakdown per turn for the agent; compare a hot turn against the 30-day median. Look for: ledger transcripts leaking into DISPATCH input, a scout report returned uncompressed, or retry loops re-sending oversized payloads.
**Escalate to:** the developer digest. The fix is usually in the compression boundary (specialist summaries, bounded dispatch payloads), not in a budget increase — budgets absorb burn, compression prevents it.

# approval_wait_sla

**Means:** p95 approval wait has crossed 30 min — the developer is the pipeline bottleneck (the human-latency alert; the agents are fine).
**First check:** `approval_wait_seconds` distribution over the window, then which APPROVAL_REQUEST classes dominate (`blastRadius` and `whyRisky`). High blast-radius requests clustering is expected occasionally; a steady 30+ min p95 means the gate friction is structural.
**Escalate to:** the developer themselves: either expand pre-granted approvals in TASK `constraints.approvals_pregranted` for well-understood scopes, or schedule work when they'll be responsive. No agent-side fix exists, by design — the gate is load-bearing.

# first_attempt_pass_drop

**Means:** the test agent's first-attempt pass rate dropped >20 points on a run — the suite is degrading (new flaky tests, environment churn, or a real defect cluster), even if final verdicts stay green through retries.
**First check:** the run report's per-class counts and which testIds failed first attempt; look for shared environment (same fixture/service class) or a recent commit touching shared test scaffolding. Distinguish class `environment` clusters (infra) from `flake` clusters (determinism debt) from `defect` clusters (real regressions).
**Escalate to:** the developer digest with evidence packs for `defect` tests and quarantine proposals for confirmed `flake` — the run report already packages both; route each to its lane rather than summarizing it away.

# task_budget_pressure

**Means:** a task has consumed ≥80% of its TASK-level token or wall-clock budget while still mid-pipeline — the per-dispatch budgets have not stopped aggregate overrun.
**First check:** the STATUS frames' `budgets.task{used/planned}` trend plus the pipeline stage — a research task over token budget is usually uncompressed scout output; a build task over wall clock is usually retry loops (see retry_rate_anomaly).
**Escalate to:** the EO routes upward per protocol: on hitting 80% the IO emits a STATUS marked `budget_pressure: true`; the developer chooses — extend the budget (new TASK_REVISION with a new budget), narrow scope, or let the pipeline settle at the next clean state and report what remains (the ledger captures it for resume).
# adversarial_rejection_rate

**Means:** the adversarial gate rejected >50% of proposals seen in the window — the proponent loop is thrashing or the gate is attached to the wrong proposals (adversarial design trade-off 1: false rejections stall healthy plans).
**First check:** `agent_loop_iterations_total{gate}` per task plus the REJECTED flaw lists in DECISION ledger entries — are the same flaws recurring across iterations (revision owner ignoring them) or are different flaws surfacing each round (gate misattached to a structurally-weak proposal)?
**Escalate to:** the developer digest with one representative flaw log; recalibrate attach criteria (adversarial §Attach criteria) or revisit the proposal source before widening the cap.
