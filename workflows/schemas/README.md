# Schemas — machine-checkable contracts for the suite

The protocol and RESULT contracts in `workflows/` were previously prose-only; these JSON
Schemas (draft 2020-12) are their deterministic form, so contract enforcement stops being
orchestrator-model judgment ("the IO validates the payload") and becomes a schema check
any harness can run before a frame is acted on.

| File | Covers | Spec source |
|---|---|---|
| `envelope.schema.json` | All 14 EO ⇄ IO wire types (v1), envelope header, trace context | `orchestrator-external/protocol.md` |
| `results.schema.json` | DISPATCH record, per-specialist RESULT contracts (scout plan build test docs steelman contrarian), ledger entries | `orchestrator-internal/protocol.md` |

## Using them

- A JSON-Schema 2020-12 validator with format support (e.g. ajv + ajv-formats)
  validates an envelope frame directly against `envelope.schema.json`. The repo's own
  runtime wrapper is `shared/wire.ts` (`checkEnvelope` / `checkResult` / `checkDispatch`
  / `checkLedgerEntry`), pinned by `tests/wire.test.ts` — prefer it over re-implementing.
- `results.schema.json` root validates a RESULT payload tagged by `specialist` — the
  tag binds the payload to exactly one contract, so a payload shaped for another
  specialist fails. `dispatch` and `ledgerEntry` are `$defs` subsets: compile
  `results#/$defs/dispatch` / `results#/$defs/ledgerEntry` separately.
- Validation order per the protocol's minimal validator contract: JSON parses and `v`
  matches → `type` known (schema `enum`) → required payload fields present (schema) →
  `ref` resolves (non-schema, transport-level) → transport size limits.
- Schema failure = contract violation = specialist FAILURE, per
  `orchestrator-internal/protocol.md`. The IO's semantic checks (citation resolves, DAG
  acyclic, goal identity in adversarial iterations) remain model-layer judgment and run
  **only after** a schema-valid result.

## Invariant

**The schemas and the protocol tables must change together.** The protocol docs carry a
pointer to these files in both directions, and `tests/spec-drift.test.ts` enforces it in
`npm test`: every field named in the wire-type and RESULT contract tables must exist in
the schemas, every schema-required field must appear in the tables, and the fenced JSON
blocks (envelope, dispatch record, ledger entry) must match their `$defs` shapes. A
divergence fails CI with the offending token named — fix both sides in the same change.
Schema changes land as PRs on `spec/<area>` branches (README §Version control
conventions) with the drift test green in the same commit; wire-semantic changes add a
protocol version bump per EO-protocol §Versioning.