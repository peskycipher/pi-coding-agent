# Agent Suite — Monitoring, Tracing, and Alerting Plan

Strategy for quickly debugging the suite in `workflows/` (scout, planning, build, test,
docs, the adversarial gate agents, orchestrator-internal, orchestrator-external).
Grounded in the observability skill's principles: define the debugging questions first,
then pick the minimum signals that answer them; alert on symptoms, not causes; verify
the telemetry itself.

## The questions a debugger of this suite will ask

Every signal below must answer one of these:

1. **Which agent failed, and why** — which specialist, which lane/bucket, what evidence?
2. **Where did the task's time and tokens go** — per stage, per specialist, per tool call?
3. **Did a specialist return garbage** — contract violations, conflicting reports?
4. **Is a non-deterministic failure reproducible** — seed/order/tool sequence of the run
   that failed, replayable from telemetry alone without reading source?

## Trace ID model (linking one request across agents)

Trace context rides the existing protocol envelope as optional v1-compatible fields (no
wire break; validators ignore unknown fields — NAK-on-unknown toggle per EO-protocol
§Versioning):

```json
{ "trace": { "trace_id": "<= task_ref", "span_id": "<uuid>", "parent_span_id": "<uuid|null>" } }
```

- EO creates `trace_id = task_ref` at TASK creation and stamps `entry_point: "external"`.
- IO's DISPATCH for each specialist becomes a child span (`parent = EO task span`);
  specialists stamp their own `entry_point` (scout/plan/build/test/docs/gate agents) on
  everything they emit.
- Specialist tool calls are grandchild spans inside the specialist's session; each RESULT
  echoes the span id so the IO can stitch dispatch → result.
- The ledger records `(trace_id, span_id, parent, kind, summary)` for every envelope and
  ledger event, so a trace survives sandbox teardown and restarts even when the sandbox's
  own session file is lost.
- Correlation rule: `trace_id` and `entry_point` propagate across every boundary — every
  log line, every ledger entry, every span — stamped where the frame **originates**, never
  inferred downstream.

## Signals to capture

### Per-agent (specialist and orchestrator alike)
| Signal | Captured as | Notes |
|---|---|---|
| Inputs | DISPATCH `input` + `instruction` (payload, bounded) | in span attributes; never raw transcripts |
| Outputs | RESULT payload fields | the RESULT **contract fields only** (see orchestrator-internal/protocol.md); violations logged |
| Tool calls | span per call: tool role, args digest (first 200 chars), duration, outcome | args digest, not full args — secrets/injection surface |
| Errors | structured log event + span status | classified: contract-violation / timeout / tool-error / budget-exhausted |
| Latency | histogram spans: queue→dispatch→result per stage | p50/p95/p99, never averages |
| Token usage | per specialist turn: prompt/completion tokens | from the harness usage record (pi/Langfuse emits this natively) |

### Metrics (RED on every agent and every bus hop; bounded labels only)
- `agent_task_total{agent, outcome}` — tasks settled green/unresolved/interrupted
- `agent_dispatch_duration_seconds{agent, stage}` — histogram
- `agent_tokens_total{agent, direction}` — cost debugging without exploding rows
- `agent_tool_calls_total{agent, tool_role}`
- `agent_contract_violations_total{specialist}` — "did a specialist return garbage"
- `agent_retry_total{agent, lane}` and `agent_budget_overrun_total{agent}`
- `agent_loop_iterations_total{agent, gate}` and `agent_gate_skipped_total{gate}` — adversarial
  gate attach/iteration accounting (spec-stage gates roll up under `gate="spec"`)
- `agent_docs_stale_claims_total{risk_class}` — docs agent drift events
- `agent_nak_total{side}` — protocol drift alarm
- `approval_wait_seconds` — human-latency gating the pipeline (EO gate → developer)
- `agent_heartbeat_age_seconds{agent}` — last STATUS age while pipeline active

Never a label: task_ref, file paths, error text, user identity (those live in logs/traces).

Heartbeat producer: the IO's STATUS frames — the protocol obligates a no-change STATUS at
least every 30 s while dispatches are outstanding (EO-protocol §Heartbeat), so the metric
is derived from STATUS arrival timestamps; nothing else emits heartbeats.

### Logs (structured JSON events, one stream per tier, entry-point stamped)
`task_received`, `dispatch_sent`, `result_received`, `contract_violation{fields missing}`,
`lane_exhausted{lane, key}`, `escalation_raised`, `approval_requested|granted|denied`,
`artifact_exported{kind, sha256}`, `ledger_appended{kind}`, `heartbeat_missed`,
`gate_attached{gate, iteration}`, `gate_skipped{gate, reason}`,
`docs_drift_detected{file, risk_class}`. Sanitization applies: the EO boundary already
strips secrets inbound; telemetry inherits the same redaction pass (EO-protocol §Sanitization
procedure) before export.

## Storage and viewing

| Data | Store | Why |
|---|---|---|
| LLM traces/spans + token usage | **Langfuse** (local dev note: already configured on this machine via `~/.pi/agent/langfuse.json`; a portable spec consumer configures its own instance) | native LLM trace UI: span tree per `trace_id = task_ref`, token/cost views, prompt comparison for debugging rewrites |
| Structured logs + ledger replay | JSONL per task on the developer machine (`~/.agent-suite/logs/<trace_id>.jsonl`), plus the ledger as system of record | greppable offline (`jq`), survives sandbox teardown, zero infra |
| Aggregate metrics | OTel metrics API → any Prometheus-compatible sink (self-hosted Prometheus + Grafana, or the Langfuse environment's metrics option) | RED dashboards without new vendor lock-in |
| Artifacts | existing quarantine dir + sha256 manifest (unchanged) | provenance already spec'd in the EO protocol |

Viewing workflow for a debugging session: trace_id from the failure report → Langfuse trace
(span tree shows where time/tokens went) → task's JSONL for the log details → ledger for
decisions and revisions. One request reconstructable end-to-end: this is the acceptance test.

## Alerting (symptoms only; two severities: page, ticket)

| Alert | Threshold (start values) | Severity |
|---|---|---|
| Task FAILURE with no recoveryOptions | any | page |
| Pipeline stalled: `heartbeat_age > 5 min` while dispatches outstanding | 1 occurrence | page |
| COMPLETION rejected by the EO gate twice for the same task | 2 | page |
| NAK loop: >2 NAKs in one session | per session | page (protocol drift) |
| Contract-violation rate > 20% of dispatches over 1h | rate | ticket |
| Retry rate > 2x trailing 7-day baseline per agent | rate | ticket |
| Token burn p95 > 3x baseline per agent (z-score) | daily window | ticket |
| approval_wait p95 > 30 min | window | ticket (developer is a bottleneck) |
| First-attempt pass rate drop > 20 pts (test agent) | per run | ticket (suite quality signal) |
| Adversarial REJECTED rate > ~50% across tasks (24h) | rate | ticket (doom loop / gate misattach — adversarial design trade-off 1) |
| Task-level budget ≥ 80% consumed before pipeline settles | per task | ticket (alerts.yaml `task_budget_pressure`) |

Every alert ships with a three-line runbook (what it means / first query / who decides),
stored beside the plan. Alert channels: local push/notification for page (this suite runs
on a developer machine; there is no pager rotation), digest for tickets. Inventories are
kept equal: alerts.yaml, this table, and runbooks.md cover the same name set — the eval
suite's drift discipline applies here too (add to all three or none).

## Trade-offs and risks

1. **Silent specialist: empty assistant message on some models (observed 2026-10-11):**
   small reasoning models can settle a turn with no assistant text at all — the deepseek-
   v4.1-flash pane in the adversarial pipeline acceptance run produced two empty turns on
   a verdict-only-shaped task where glm-5.3-flash answered fine. This is a protocol-class
   signal, not a content verdict: the orchestrator should treat "settled turn with zero
   assistant message" like a specialist failure — re-dispatch once with the contract
   restated ("output ONLY the verdict lines"), then classify as failure and route by lane.
   Detection: settled `result_received` with empty payload text. This also means model-tier
   recommendations are per-capability, not universal: glm-5.3-flash handled verdict-only
   output where deepseek-v4.1-flash did not, so small-model notes should be validated per
   model during adoption.
2. **Full fidelity vs cost:** capture 100% of failures and NAKs, sample successful
   dispatches 10% by default (raise to 100% while debugging). Risk: a sampled-out success
   that later turns out to have gone wrong silently — accepted; the ledger still has the
   compressed result.
3. **Ephemeral sandbox kills telemetry on crash** — the biggest hole. Mitigation adopted
   above: the IO streams its structured log + ledger continuously via ARTIFACT_TRANSFER
   before any teardown, so the durable copy lives outside. Residual: a hard sandbox kill
   loses the last seconds — acknowledged and documented.
4. **Langfuse cloud vs self-host:** cloud is fastest to start and already configured
   (local dev note above); risk is payload exposure (prompt content in traces). Mitigation:
   telemetry passes the same EO redaction pass (EO-protocol §Sanitization procedure)
   before export, spans carry digests and structured contract fields — never raw prompt
   bodies; self-host when workspace source must not leave the machine.
5. **Cardinality bombs:** task_ref/paths as metric labels would be fatal; discipline is
   labels-bounded, values-in-logs. Enforce in the metrics emitter, not by convention.
6. **Alert noise trains neglect:** start with the four page rules only; adding a fifth
   requires an incident that the existing four failed to catch — same discipline as the
   agents' escalation thresholds.
7. **Tracing is the IO's cost:** stamping/spending spans on every dispatch adds latency
   and tokens; spans carry digests, not transcripts, to keep this bounded.

## Implementation steps

0. **Version control for the specification itself** — every change to these documents
   (protocols, schemas, alerts, runbooks) lands as a PR on a `spec/<area>-<slug>` branch
   (README §Version control conventions), with the drift check (`npm test`) green in the
   same change. Changes to wire semantics additionally bump the protocol version per
   EO-protocol §Versioning; the tag cut follows the release procedure after review.
1. **Envelope extension** — add optional `trace` fields to both protocol docs + NAK toggle
   (already spec'd in both protocol docs and `envelope.schema.json`; this step is now
   *implement stamping only*). EO generates `trace_id` at intake. (~1 h)
2. **IO/specialist stamping** — stamp spans on dispatch/result; echo span ids in RESULTs;
   specialists log structured JSON to the bus. (~half day)
3. **Wire Langfuse** — export spans with `trace_id = task_ref`; confirm existing config
   captures pi sessions with token usage. (~2 h)
4. **Metrics emitter** — derive metrics from STATUS frames and ledger appends (no agents
   change behavior). (~half day)
5. **Dashboards + log layout** — RED board per agent; JSONL-per-task layout; jq recipes
   in the runbook. (~2 h)
6. **Alerts + runbooks** — the four page rules first; test-fire each once. (~2 h)
7. **Acceptance test** — force a failure in a scratch task; reconstruct cause, latency,
   and token profile from telemetry alone, without reading source. Repeat after any
   protocol change (same spirit as the protocol-drift audit).