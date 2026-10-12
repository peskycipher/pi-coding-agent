# Dashboards and Log Layout

Implementation step 5 of `plan.md` §Implementation steps: the RED board per agent and the
JSONL-per-task log layout, plus the `jq` recipes the runbooks point at. This document is
the layout authority; the numbers in the alert rules remain `alerts.yaml`'s, and the
timeout numbers remain `orchestrator-external/protocol.md` §Timeouts'.

## Exporter (`shared/exporter.ts`)

The emitters in `shared/telemetry.ts` are the write side; the exporter is the read side.

- **Metrics → Prometheus text.** `toPrometheus(metrics.snapshot())` renders every sample in
  Prometheus 0.0.4 exposition format. Counters emit their logical value (`sum`); declared
  histograms emit `_bucket{le=…}`, `_sum`, and `_count` lines over `DEFAULT_HISTOGRAM_BUCKETS`.
  Point any Prometheus-compatible scrape at the IO harness's registry (or its HTTP export).
- **Logs → JSONL per task.** `new TaskJsonlSink(write, root)` routes each `LogRecord` to
  `<root>/<trace_id>.jsonl` (`root` defaults to `~/.agent-suite/logs`). `toJsonl(records)`
  produces the same body for an `ARTIFACT_TRANSFER` before teardown, so the durable copy
  lives outside the ephemeral sandbox.
- **Reader half.** `parsePrometheusText` / `findMetric` / `metricValue` parse the exported
  text back; `tests/observability-acceptance.test.ts` reconstructs a failed run with them
  and no other input.

## Log layout (one file per task)

```
~/.agent-suite/logs/<trace_id>.jsonl
```

One JSON object per line; `<trace_id>` is the task ref with any character outside
`[A-Za-z0-9._-]` replaced by `_` (so a task ref cannot escape the log root). Every record
carries `ts`, `event`, `trace_id`, and `entry_point` (the frame origin — never inferred
downstream). Values (evidence, error text, args digests) live here; metrics carry only
counts, because `task_ref` / paths / error text are not bounded labels.

Events are the `LogEvent` union from `shared/telemetry.ts`: `task_received`,
`dispatch_sent`, `result_received`, `contract_violation`, `lane_exhausted`,
`escalation_raised`, `approval_requested|granted|denied`, `artifact_exported`,
`ledger_appended`, `heartbeat_missed`, `gate_attached`, `gate_skipped`,
`docs_drift_detected`.

### jq recipes

```sh
# Everything that happened in a failed task, in order.
jq -c . ~/.agent-suite/logs/<trace_id>.jsonl

# Why did it fail: contract violations and the exhausted lane.
jq -c 'select(.event=="contract_violation" or .event=="lane_exhausted")' \
  ~/.agent-suite/logs/<trace_id>.jsonl

# Where did the time go: dispatch/result pairs with the specialist named.
jq -c 'select(.event=="dispatch_sent" or .event=="result_received")' \
  ~/.agent-suite/logs/<trace_id>.jsonl

# Which tasks saw a docs drift and at what risk class.
jq -c 'select(.event=="docs_drift_detected")' ~/.agent-suite/logs/*.jsonl
```

## RED board per agent

RED = **R**ate, **E**rrors, **D**uration. One row per deployed specialist
(`scout`, `plan`, `build`, `test`, `docs`, `steelman`, `contrarian`), sourced from the
Prometheus export; a panel is per-agent with a label filter.

| Panel | Signal | PromQL (after scraping) |
|---|---|---|
| Rate | tasks settled by outcome | `sum by (outcome) (rate(agent_task_total{agent="io"}[5m]))` |
| Errors — contract | violations per specialist | `sum by (specialist) (rate(agent_contract_violations_total[5m]))` |
| Errors — retries | retries per agent/lane | `sum by (agent, lane) (rate(agent_retry_total[5m]))` |
| Errors — gate | adversarial rejections vs approvals | `sum(rate(agent_loop_iterations_total{gate="adversarial"}[5m]))` |
| Duration | dispatch p50/p95/p99 per agent/stage | `histogram_quantile(0.95, sum by (agent, le) (rate(agent_dispatch_duration_seconds_bucket[5m])))` |
| Cost | tokens per agent/direction | `sum by (agent, direction) (rate(agent_tokens_total[5m]))` |
| Liveness | heartbeat age (gauge view of the histogram) | `max_over_time(agent_heartbeat_age_seconds_sum[5m])` |
| Human gate | approval wait p50/p95 | `histogram_quantile(0.95, sum by (le) (rate(approval_wait_seconds_bucket[1h])))` |
| Adversarial | gate attach vs skip | `sum(rate(agent_gate_skipped_total[1h])) by (gate)` |
| Docs | stale claims by risk class | `sum by (risk_class) (rate(agent_docs_stale_claims_total[1h]))` |
| Budget | per-dispatch overruns | `sum by (agent) (rate(agent_budget_overrun_total[1h]))` |

Percentiles come from the histogram buckets — never a mean (plan §Signals, Latency). The
board's alert thresholds are the `alerts.yaml` values; the board is for looking, the
alerts are for paging.

## Debugging workflow (one request end to end)

1. Failure report gives `trace_id` (= task ref).
2. Open the Langfuse trace for `trace_id` — the span tree shows where time and tokens went.
3. Read the task's JSONL for the log details (`jq` recipes above).
4. Read the ledger for decisions and revisions (`seq`, `kind`, `status`).
5. The acceptance test (`tests/observability-acceptance.test.ts`) asserts steps 2–4 are
   reconstructable from telemetry alone after any protocol change.
