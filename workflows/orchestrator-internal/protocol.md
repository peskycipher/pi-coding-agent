# Internal Orchestrator — Protocol Details

How the IO consumes EO dispatches and drives the specialist roster (four live; docs
docs adopted; the adversarial gate agents (steelman/contrarian) are adopted gate agents
per workflows/adversarial/design.md) — this document defines
the internals of the role that manages a single development pipeline from within its own
sandbox (README §The two roles): the wire schema for
EO ⇄ IO is defined in `workflows/orchestrator-external/protocol.md`; this document adds
the internal side: specialist dispatch records, ledger events, and the bus semantics.
Machine-checkable forms: `workflows/schemas/envelope.schema.json` (wire types) and
`workflows/schemas/results.schema.json` (dispatch records, RESULT contracts, ledger
entries) — the schemas and the tables below must change together.

## Envelope (bus form — not authoritative)

The wire schema for EO ⇄ IO — envelope fields, the message-type table, and all payload
schemas — is defined in `workflows/orchestrator-external/protocol.md`, which is the
single authority. Specialist bus frames **reuse** that envelope structure with one
extension, and they are **not** valid EO ⇄ IO envelopes: bus frames may carry specialist
identities in `from`/`to`, so do **not** validate them against
`workflows/schemas/envelope.schema.json` — use `checkDispatch`/`checkResult`
(`shared/wire.ts`) instead. The payload field lists for every type below live in the
external protocol's message-type table; nothing on this page re-lists them.

```json
{
  "v": 1,
  "id": "msg-<uuid>",
  "ref": "<message id or task id this replies to>",
  "ts": "<iso8601>",
  "from": "external | internal | scout | plan | build | test",
  "to": "<one of the same, never a specialist-to-specialist send>",
  "type": "<Message Type>",
  "task_ref": "<task id, present on task-scoped messages>",
  "payload": { }
}
```

Optional trace context rides the same envelope (EO creates `trace_id = task_ref` at TASK;
the IO stamps dispatch/result spans as children and echoes span ids in RESULTs — full
model in `workflows/observability/plan.md`).
```json
{ "trace": { "trace_id": "<defaults to task_ref>", "span_id": "<uuid>", "parent_span_id": "<uuid | null>" } }
```

Specialists communicate only with `internal`. Two specialists have no direct channel;
their coordination substrate is the ledger.

## Message types by direction (obligations only — payloads per the external protocol)

### EO → IO — the IO's obligation per type
| Type | IO obligation |
|---|---|
| `TASK` | Stage 1 intake; ack with STATUS |
| `TASK_REVISION` | treat as a new decision point; re-enter delegation planning; ledger the revision |
| `CLARIFICATION_ANSWER` | resume pipeline, ledger the answers |
| `APPROVAL_RESPONSE` | ledger the grant; scope-bound action may proceed; changed blast radius → new APPROVAL_REQUEST |
| `INTERRUPT` | stop at next clean state; export artifacts; final STATUS |
| `ARTIFACT_RESPONSE` | ledger and continue |
| `NAK` | fix the frame and re-send (max 2; then FAILURE upward) |

### IO → EO — the IO's obligation per type
| Type | IO obligation |
|---|---|
| `STATUS` | emit on state change and as the periodic heartbeat (EO-protocol §Heartbeat; budgets per §Budget semantics) |
| `CLARIFICATION` | questions + `resumePoint`; pipeline parked until answered |
| `COMPLETION` | emitted only with the verdict block — the EO NAKs a completion missing `verdictAttenuations`/`artifactRefs` (empty-but-explicit is valid) |
| `FAILURE` | terminal unless `recoveryOptions` includes `resume` |
| `ARTIFACT_REQUEST` | one sanctioned need per frame; a NAK is terminal for that need (EO-protocol §Egress constraints) |
| `ARTIFACT_TRANSFER` | durable output export; sha256-tagged, idempotent at the EO (§Ledger custody) |
| `NAK` | mirror the EO's NAK rules |

### IO → Specialist (DISPATCH) and back (RESULT)

Dispatch record (also the blackboard entry):

```json
{
  "dispatch_id": "d-<n>",
  "specialist": "scout | plan | build | test",
  "task_ref": "<task id>",
  "instruction": "<bounded, one-step purpose>",
  "input": { "goal": "...", "constraints": [...], "ledger_refs": [...] },
  "requires_tools": ["<roles from that specialist's own inventory in workflows/<specialist>/workflow.md, e.g. scout: glob, grep, read, web-search>"],
  "budget": { "tool_calls": 15, "seconds": 300 },
  "reply_expected": "RESULT"
}
```

Specialist RESULT contract per specialist (validated on arrival; field names are the
specialists' own output-format fields from their workflow.md — the IO consumes those,
it does not invent a mapping layer):
| Specialist | Required RESULT payload fields |
|---|---|
| `scout` | verdicts[] (include/exclude/include-with-summary rows), findings[{claim, citation, confidence, phase: "final"\|"conflict"}], verdict_stats{included, summarized, excluded, unreachable}, gaps[], handoff{next_stage, payload} |
| `plan` | steps[{id, action, tool_role, depends_on, done_when, binds}], assumptions[{statement, status}], parallel_groups[], single_points_of_failure[] |
| `build` | outcome: green\|unresolved, changed_files[], verification_evidence[{check, exit}], lanes_used[], notes |
| `test` | verdicts[{testId, class, evidence}], first_attempt_pass_rate, attested[], not_attested[], gaps[] |
| `docs` (adopted — workflows/docs-agent/design.md) | doc_updates[{path, change, evidence[], risk}], claims_index_delta[], release_notes?, verdict{attested[], stale_sections[]} |
| `steelman` + `contrarian` (adopted; conditional gate attach — workflows/adversarial/design.md) | steelman: {goal, proposal, premises[{claim, basis}], preempted_objections[], open_problems[]} \| {structural_flag} contrarian: {verdict: APPROVED\|REJECTED\|PROTOCOL_INVALID, fatal_flaws[{claim, breaks, why}]?, protocol_invalid_reason: naive-draft\|contamination?} — the prompt's verdict lines ("VERDICT: REJECTED …") normalize into these payload fields; contrarian receives steel-man output only |

Contract violations are treated as specialist FAILURE (retry once, re-formed).

Wall-clock defaults (overridable per dispatch via `budget.seconds`): 300 s for scout/plan,
15 min for a single build execution, 30 min for a test-suite run. A specialist exceeding
its wall clock arrives as TIMEOUT and follows the same retry-then-lane path as a failure
(EO-protocol §Timeouts); the heartbeat the EO monitors is the IO's periodic STATUS, so a
pending long build is declared via a STATUS marked as in-flight, never by silence.

## Ledger (blackboard) events

The ledger is append-only; the IO is the sole writer. Entries:

```json
{ "seq": n, "ts": "...", "kind": "TASK|ASSUMPTION|DISPATCH|RESULT|DECISION|REVISION|ARTIFACT_EXPORT",
  "ref": "<dispatch/task id>", "trace_id": "<task_ref>", "span_id": "<uuid | null>",
  "summary": "<compressed, not transcripts>", "status": "..." }
```

`trace_id`/`span_id` ride the ledger so traces survive sandbox teardown and restarts
(observability plan §Trace ID model).

Ledger custody and crash consistency:
- **`seq` is allocated by the EO** at persistence time (the EO is the persistence tier —
  protocol: ledger + artifacts live outside the sandbox). The IO writes entries with an
  empty `seq`; the EO stamps the monotonic number on receipt and echoes it in the next
  STATUS `lastEvent`. On restart, a re-emitted entry is matched by `(task_ref, ref, ts)`,
  never by its own `seq` — an IO crash mid-append therefore cannot corrupt the sequence.
- **Re-dispatch dedup on restart:** a dispatch whose ledger shows a contract-valid RESULT
  (or entries still void/re-doable per the dead-path rule) is not re-dispatched; only
  `voided` and interrupted-in-flight entries re-run. The IO also keys re-dispatch by
  `(specialist, task_ref, hash(input))` so a half-written result from a dead specialist
  turn is never double-counted.
- **ARTIFACT_TRANSFER idempotency:** the EO ignores a transfer whose `sha256` is already
  in the artifact store for the same `task_ref` — exports are safely retryable under
  recovery and repeated INTERRUPT handling. The same applies to patch exports: durable
  git history is created EO-side from patches (README §Version control conventions),
  so a re-exported patch after a crash is an idempotent no-op at the EO, not a fresh
  commit.
- A second `INTERRUPT(reason: teardown)` while teardown is in progress is idempotent:
  the IO continues the same bounded finalization, it does not restart it.

Waking rule (blackboard semantics): a dispatch is eligible when its dependency entries are
final; nothing needs to message anything — the IO polls the ledger state machine.

## Restart and teardown semantics

1. On sandbox start, the IO reads the ledger it is handed by the EO (persisted outside).
2. Entries referencing local paths are validated; dead paths → entry `status: voided`,
   work redoable by re-dispatch. Assumptions and decisions survive; results tied to
   ephemeral files only survive as summaries + exported artifacts.
3. Teardown imminent (`INTERRUPT` with `reason: teardown`): the decision and timing are
   the EO's (sandbox destruction is its role — README §The two roles); the IO's duty is
   the bounded finalization: finish or void in-flight dispatches, ARTIFACT_TRANSFER
   everything in the keep-set, emit final STATUS. Local commits join the keep-set via
   the exported patches.

## Ordering and idempotency

- Exactly-one outstanding dispatch per specialist; the IO fans out only independent ones.
- Every RESULT must carry `ref: dispatch_id`; unmatched results are rejected (stale or
  spoofed specialist turn).
- Repeating a TASK with the same `task_ref`: the IO answers from the ledger rather than
  re-running (idempotent re-ask), unless the EO marks `retry: fresh`.