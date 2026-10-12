// Deterministic contract validation for the workflows/ suite wire and RESULT contracts.
//
// The JSON Schemas in ../workflows/schemas/ are the single source of truth (see that
// README): this module compiles them with ajv and exposes the validation order of the
// protocol's minimal validator contract — JSON parses and `v` matches → type known →
// required payload fields present → (transport-level checks remain outside this module).
// Schema failure = contract violation = specialist FAILURE per
// workflows/orchestrator-internal/protocol.md. Semantic checks (citation resolves, DAG
// acyclic) remain model-layer judgment and run only after a schema-valid result.
//
// Harness note: pure module — no node APIs, safe for both the Worker bundle and any
// Node-side consumer (tests, future EO tooling).

import envelopeSchema from "../workflows/schemas/envelope.schema.json" with { type: "json" };
import resultsSchema from "../workflows/schemas/results.schema.json" with { type: "json" };
import Ajv2020 from "ajv/dist/2020.js";

export type ValidationFailure = { ok: false; errors: string[] };
export type ValidationSuccess = { ok: true };
export type ValidationResult = ValidationSuccess | ValidationFailure;

// ajv-formats is a dependency for exactly two formats; the validators are inlined to keep
// the module self-contained the way shared/*.ts conventions expect.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const URI = /^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/;

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("date-time", { validate: (s: string) => DATE_TIME.test(s) });
ajv.addFormat("uri", { validate: (s: string) => URI.test(s) });

const validateEnvelope = ajv.compile(envelopeSchema);
ajv.addSchema(resultsSchema, "results");
const validateTaggedResult = ajv.compile(resultsSchema);
const validateDispatch = ajv.compile({
	$ref: "results#/$defs/dispatch",
});
const validateLedgerEntry = ajv.compile({
	$ref: "results#/$defs/ledgerEntry",
});

function failure(kind: string, errors: string[] | undefined): ValidationFailure {
	return { ok: false, errors: (errors ?? []).map((e) => `${kind}: ${typeof e === "string" ? e : JSON.stringify(e)}`) };
}

/** EO ⇄ IO wire frame, per the message-type tables. A `v` mismatch or unknown type fails here. */
export function checkEnvelope(frame: unknown): ValidationResult {
	if (!validateEnvelope(frame)) return failure("envelope", errorTexts(validateEnvelope));
	return { ok: true };
}

/** RESULT payload for one dispatch, tagged by `specialist`. */
export function checkResult(payload: unknown): ValidationResult {
	if (!validateTaggedResult(payload)) return failure("result", errorTexts(validateTaggedResult));
	return { ok: true };
}

/** DISPATCH record (also the blackboard entry) — IO design §Sandbox constraints shape. */
export function checkDispatch(record: unknown): ValidationResult {
	if (!validateDispatch(record)) return failure("dispatch", errorTexts(validateDispatch));
	return { ok: true };
}

/** Ledger entry — IO writes, EO persists and stamps `seq`. */
export function checkLedgerEntry(entry: unknown): ValidationResult {
	if (!validateLedgerEntry(entry)) return failure("ledger", errorTexts(validateLedgerEntry));
	return { ok: true };
}

function errorTexts(v: { errors?: unknown[] | null }): string[] {
	return (v.errors ?? []).map((e) => JSON.stringify(e));
}