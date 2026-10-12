# Communication Protocol — EO ⇄ IO

Lightweight envelope over the dedicated EO-owned channel (e.g., SSH/socket to the sandbox
supervisor process; transport-agnostic by design). JSON, one envelope per frame, newline-
delimited or length-prefixed per transport. Machine-checkable form of every wire type:
`workflows/schemas/envelope.schema.json` — the schema and the tables below are kept
strictly in sync and must both change together.

## Envelope

```json
{
  "v": 1,
  "id": "msg-<uuid>",
  "ref": "<message id or task id this replies to>",
  "ts": "<iso8601>",
  "from": "external | internal",
  "to": "external | internal",
  "type": "<Message Type>",
  "task_ref": "<task id, present on task-scoped messages>",
  "payload": { }
}
```

Optional trace context (added by the observability plan, `workflows/observability/plan.md`;
absent frames are processed as if no trace existed):

```json
{ "trace": { "trace_id": "<defaults to task_ref>", "span_id": "<uuid>", "parent_span_id": "<uuid | null>" } }
```

Rules: `to` is always the peer (never a specialist — those dispatches live inside the
sandbox bus, see `workflows/orchestrator-internal/protocol.md`). Every reply carries
`ref` of what it answers. Unknown types are NAK'd, not applied. Unknown envelope fields
are ignored in v1; once trace contexts are adopted, a frame omitting `trace` on a
task-scoped message MAY be flagged for telemetry completeness but is not NAK'd.

## Message types

### Developer-intent ⇄ EO (local; not on the wire)
The EO maintains its own conversational thread; the developer never produces wire frames.

| Wire type | Direction | When | Payload |
|---|---|---|---|
| `TASK` | ext → int | new request or revised scope | goal, constraints{files, deps, approvals_pregranted}, sandbox{tools[], budgets, network: "none"\|"proxy"}, budget{wall_clock_task, tokens_task}, route?{mode: "single"\|"parallel", sandboxes?: [{track, modules[], specRef?}]}, session{ledgerRef, artifactsDir, specRef?} |
| `TASK_REVISION` | ext → int | developer changes scope/goal | delta + reason; IO treats as new decision point |
| `CLARIFICATION_ANSWER` | ext → int | answering a CLARIFICATION | answers keyed by question id |
| `APPROVAL_RESPONSE` | ext → int | answering an APPROVAL_REQUEST | approved: bool, scope: what was approved, expires |
| `INTERRUPT` | ext → int | cancel, or teardown imminent | reason: "user" \| "timeout" \| "teardown" |
| `ARTIFACT_RESPONSE` | ext → int | sanctioned fetch result | blobRef (inside sandbox), sanitized: bool, notes |
| `STATUS` | int → ext | any state change, plus a no-change heartbeat at least every 30s while dispatches are outstanding | stage, specialists{scout,plan,build,test}, budgets{task:{used,planned}, per-specialist used/planned}, lastEvent, budget_pressure? |
| `CLARIFICATION` | int → ext | goal/scope ambiguity | questions[{id, text, defaultAssumption}], resumePoint |
| `APPROVAL_REQUEST` | int → ext | gate hit | action, blastRadius, whyRisky, alternatives |
| `COMPLETION` | int → ext | task settled green | summary, verdictAttenuations[], artifactRefs[], ledgerRef |
| `FAILURE` | int → ext | task settled red or unrecoverable | failingStep, classification, evidence[], attempts[], recoveryOptions[] |
| `ARTIFACT_TRANSFER` | int → ext | export durable output | artifactRef, kind (file/log/patch), sha256, quarantine metadata |
| `ARTIFACT_REQUEST` | int → ext | needs sanctioned external content | url or descriptor, whyEgressNeeded, expectedSize |
| `NAK` | both | malformed/unknown/late frame | error, receivedType |

Budget semantics: `budget.wall_clock_task` / `budget.tokens_task` cap aggregate task
spend across all dispatches (EO sets them at intake; `null` = unbounded, requires an
explicit developer opt-in at intake). At ≥80% the IO marks STATUS `budget_pressure: true`;
at 100% the IO stops opening new dispatches and settles at the next clean state.
Route semantics: `route.mode: "single"` = one sandbox, one IO, one ledger (the default);
`"parallel"` = N sandboxes, each an independent IO running its assigned module track
from the spec — per-sandbox ledgers merge at PR merge time under the VC conventions.
The TASK budget is the **task total** across all tracks; the EO subdivides it into
per-track allocations at provisioning.

Budget layers, defined once: **TASK `budget`** = the task-level aggregate caps above;
**`sandbox.budgets`** = per-dispatch defaults pre-declared in the sandbox profile (the
EO's pre-authorization of what each specialist may spend before any DISPATCH is sent);
**DISPATCH `budget`** = the per-dispatch values sent with each dispatch, which override
`sandbox.budgets` for that dispatch and must stay inside the TASK caps.

## Semantics

- **Envelope ordering:** frames for one `task_ref` are processed in arrival order; the IO
  treats late duplicates idempotently keyed by `ref`.
- **Trace propagation:** the EO creates the trace at TASK intake (`trace_id = task_ref`,
  `entry_point: "external"`) and stamps it on every frame it sends and echoes on every
  frame it receives; the IO stamps its dispatch/result spans as children. Every log line,
  ledger entry, and span carries `trace_id` + `entry_point` stamped where the frame
  originates, never inferred downstream. See `workflows/observability/plan.md`.
- **Progress contract:** after any TASK, the next frame is STATUS (ack). The EO may NAK a
  COMPLETION lacking `verdictAttenuations` or `artifactRefs` — those fields must exist and
  may be empty-but-explicit.
- **ARTIFACT_REQUEST egress constraints (the no-raw-egress rule, enforced):**
  1. The EO maintains a fetch allowlist (domains+paths, configured developer-side). A request whose url or descriptor resolves outside it is NAK'd (`error: fetch-not-allowed`) — the sandbox cannot nominate arbitrary hosts.
  2. Query strings and fragments are stripped before fetching; the approval prompt shows the exact final URL.
  3. `descriptor` requests are resolved by the EO against its own catalog (descriptor → candidate URLs shown for approval); the EO never fetches an unreviewed host.
  4. `expectedSize` is capped (default 10 MB); larger needs a CLARIFICATION-negotiated size. Sandbox-supplied text in `url`/`descriptor` beyond the resource name is logged as data at the EO — this channel is monitored as an outbound-data surface, not only an inbound-content channel.
  5. A NAK on ARTIFACT_REQUEST is terminal for that need: the IO continues `network-unverified` or routes the gap up; it may not re-issue the same request.
- **Sanitization procedure (concrete, replacing the vague "sanitized: bool"):**
  - *Inbound (developer → sandbox):* the EO's redaction pass runs on every payload before dispatch — known-secret patterns (env credentials, bearer/API tokens, private keys) replaced with `[REDACTED:<type>]`, the redaction logged with a category (never the matched value).
  - *Outbound (sandbox → developer):* artifacts are untrusted data. The EO verifies sha256 against the ARTIFACT_TRANSFER manifest, scans for instruction-shaped content and embedded secrets, and quotes/labels anything suspicious — never executes it. Artifacts stay in quarantine until the developer accepts.
  - *Fetched content (ARTIFACT_RESPONSE):* the EO runs the redaction pass, strips executable/script content, enforces the size cap, stores the result as a blobRef. `sanitized: true` only when the full pass completed; on failure the blob stays quarantined and `sanitized: false` + notes tell the IO the content is available-but-suspect. A blob is never injected unredacted.
- **Timeouts (defaults, overridable in the TASK budget):** specialist dispatch wall clock 300 s / 15 tool calls; build execution 15 min; test-suite execution 30 min; teardown-final-frame window 60 s — after `INTERRUPT(reason: teardown)` the EO waits 60 s for a final STATUS (with ledger export) or a FAILURE (with artifacts transferred); on expiry it treats the sandbox as lost, voids in-flight entries under the IO restart rules at the next session, and closes the channel. A specialist exceeding its wall clock is a `TIMEOUT`, handled exactly as a specialist failure (one re-formed retry, then route by lane). **These values are the single authority for timeout defaults anywhere in the suite; other documents reference this section and must not restate or change the numbers independently.**
- **Heartbeat:** the IO's STATUS frames are the heartbeat. While dispatches are outstanding the IO emits a STATUS at least every 30 s even with no state change — `agent_heartbeat_age_seconds` measures the age of the last STATUS received. Specialists do not emit heartbeats (their silence is a dispatch timeout to the IO, and a stalled pipeline to monitoring).
- **Approval semantics:** APPROVAL_RESPONSE grants a scope, not an identity token; the IO may re-request with a changed blast radius. Pre-granted approvals ride TASK `constraints.approvals_pregranted` (developer pre-authorization, EO-audited); the response's `expires` is enforced by the EO — an expired grant is treated as denied and requires a fresh APPROVAL_REQUEST, including mid-flight.
- **Artifact custody:** ARTIFACT_TRANSFER flows out continuously (ephemeral FS). Every
  artifact carries `sha256` and quarantine metadata; the EO stores artifacts outside the
  developer's working tree until accepted.
- **Sanitization boundary:** the three-part procedure (inbound redaction, outbound
  artifact scan, fetched-content handling) is defined under §Sanitization procedure
  above; this rule is its headline: applied at the EO on every frame, both directions.
- **Failure protocol:** FAILURE is terminal for the task except when its recoveryOptions
  include `resume`; the developer's choice arrives as a fresh TASK (`resume: <ledgerRef>`).
- **Teardown:** the window and expiry behavior are defined under Timeouts above; on expiry
  the EO closes the channel and may destroy the sandbox.
- **Version control at the boundary:** the sandbox never touches git remotes (egress is
  restricted; push credentials exist only at the EO). Sandbox agents commit locally on
  their designated branch for intra-task reviewability; the EO applies exported patches to
  the branch, opens PRs on green COMPLETION, and is the sole pusher of merges, tags, and
  release commits — approval-gated per the boundary rules. Convention definitions live
  in README §Version control conventions; this protocol adds no frame fields for git
  state — provenance rides `Task-Ref`/`ledgerRef` in PR descriptions and ledger entries,
  and SHAs appear in specialist report formats. **SHA provenance:** sandbox-local SHAs
  exist only within the ephemeral task tree and are preserved by nothing; verdict blocks
  and specialist reports cite the task-local HEAD SHA, while the EO records the
  patch→durable-commit mapping in the PR description — `Task-Ref`/`ledgerRef` correlate
  the two.
- **Versioning:** `v` mismatch → NAK immediately; both sides support exactly one version
  at a time. Policy: (1) adding an *optional* envelope field (e.g. `trace`) is v1-
  compatible — no version bump; unknown fields are ignored, with an optional NAK-on-
  unknown toggle once adopted. (2) A new message *type*, a new *required* payload field,
  or a changed semantic is v2: the EO negotiates at session open — the first TASK carries
  `v`, any mismatched frame is NAK'd, and a session opens only at the version the EO
  provisions the sandbox for. No negotiated downgrade mid-session.

### Session input artifacts (specRef delivery — the input direction)

`session.specRef` names the EO-side specification artifact that the sandbox must be able
to read. Delivery (EO-owned, at provisioning — README §The two roles, Sandbox lifecycle):
the EO mounts the file into the sandbox **before the first DISPATCH**, at the fixture path
declared in TASK `session.specRef` (e.g. `/input/SPEC-<task_ref>.md`), using the same
channel the sandbox supervisor already uses for bootstrap files — it is **not** an
ARTIFACT_TRANSFER (that type is sandbox→EO). Rules: the mounted spec is read-only for all
specialists (`docs-edit`/`test-edit`/edits cannot touch it); its SHA is recorded by the EO
at dispatch and re-verified by the IO at intake (spec approved at a SHA is the one that
must arrive); a TASK_REVISION changing the spec re-mounts the updated file and re-runs the
intake check. Route semantics: `route.mode: parallel` mounts the same spec into every
track sandbox unless the track's `specRef` names a module-scoped variant.

## Minimal validator contract

Both sides, before reacting to a frame: (1) JSON parses and `v` matches; (2) `type` known;
(3) required payload fields for the type present, or NAK; (4) `ref` resolves, else NAK as
late/unknown; (5) size limits enforced per transport (artifacts stream via ARTIFACT_TRANSFER,
never inline).