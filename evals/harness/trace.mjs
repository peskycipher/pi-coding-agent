// Tool-trace recorder for the eval harness (spec: workflows/test-eval-spec.md §6).
//
// Every traced tool call is exactly one JSON line validated against
// ../schemas/tool-trace.schema.json. The scorer refuses a run whose trace lines are
// invalid rather than scoring partially traced calls, so this module validates on every
// `record()` (throw by default) and re-validates on `toJSONL()`.
//
// Privacy rule (observability plan §1, mirrored by §6): only `argsDigest` is persisted —
// never raw payloads. The digest is a stable, sorted-key stringification truncated to
// 200 chars; it is an identifier for the check, not a transcript.

import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

export const TRACE_SCHEMA_ID = "evals/schemas/tool-trace.schema.json";

const SCHEMA = JSON.parse(
	readFileSync(new URL("../schemas/tool-trace.schema.json", import.meta.url), "utf8"),
);

// Inline date-time format (same pattern as shared/wire.ts) so the module stays
// dependency-light beyond ajv itself.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("date-time", { validate: (s) => DATE_TIME.test(s) });
const validate = ajv.compile(SCHEMA);

export class TraceValidationError extends Error {
	constructor(errors) {
		super(`invalid tool-trace record: ${errors.join("; ")}`);
		this.name = "TraceValidationError";
		this.errors = errors;
	}
}

/** Deterministic stringify with sorted object keys, so equal args produce equal digests. */
export function stableStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Digest tool arguments for the trace. Strings pass through; everything else is
 * stable-stringified. Hard-truncated to `max` (schema maxLength 200) so raw payloads
 * can never leak through the trace.
 */
export function digestArgs(args, max = 200) {
	let text;
	try {
		text = typeof args === "string" ? args : stableStringify(args);
	} catch {
		text = String(args);
	}
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Validate one trace record. Returns `{ ok: true }` or `{ ok: false, errors }`. */
export function validateTraceRecord(record) {
	if (validate(record)) return { ok: true };
	const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
	return { ok: false, errors };
}

/**
 * Records tool calls for one scenario run.
 *
 * `onInvalid` controls what happens when a record fails the schema: "throw" (default;
 * scorer path) or "collect" (diagnostic path — errors are exposed via `.errors`).
 */
export class TraceRecorder {
	constructor({ agent, scenario, clock = () => new Date(), onInvalid = "throw", dispatchId } = {}) {
		if (!agent) throw new Error("TraceRecorder requires an agent");
		if (!scenario) throw new Error("TraceRecorder requires a scenario");
		this.agent = agent;
		this.scenario = scenario;
		this.clock = clock;
		this.onInvalid = onInvalid;
		this.dispatchId = dispatchId;
		this.records = [];
		this.errors = [];
	}

	record({ role, args, outcome, durationMs, files, diff, dispatchId, tokens, ts } = {}) {
		const entry = {
			ts: ts ?? this.clock().toISOString(),
			scenario: this.scenario,
			agent: this.agent,
			role,
			argsDigest: args === undefined ? undefined : digestArgs(args),
			outcome,
			durationMs,
			files,
			diff,
			dispatchId: dispatchId ?? this.dispatchId,
			tokens,
		};
		for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
		const check = validateTraceRecord(entry);
		if (!check.ok) {
			this.errors.push({ entry, errors: check.errors });
			if (this.onInvalid === "throw") throw new TraceValidationError(check.errors);
		}
		this.records.push(entry);
		return entry;
	}

	toJSONL() {
		if (this.errors.length > 0 && this.onInvalid === "throw") {
			throw new TraceValidationError(this.errors.flatMap((e) => e.errors));
		}
		return this.records.map((r) => JSON.stringify(r)).join("\n");
	}

	/** Parse a JSONL trace, validating every line. Invalid lines throw (reject partially-traced runs). */
	static fromJSONL(text) {
		const records = [];
		const errors = [];
		text.split(/\r?\n/).forEach((line, i) => {
			if (line.trim() === "") return;
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch (err) {
				errors.push(`line ${i + 1}: not JSON (${err.message})`);
				return;
			}
			const check = validateTraceRecord(parsed);
			if (!check.ok) errors.push(`line ${i + 1}: ${check.errors.join("; ")}`);
			else records.push(parsed);
		});
		if (errors.length) throw new TraceValidationError(errors);
		return records;
	}
}
