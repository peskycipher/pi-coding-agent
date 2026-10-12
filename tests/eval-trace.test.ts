import assert from "node:assert/strict";
import { test } from "node:test";

import {
	TraceRecorder,
	TraceValidationError,
	digestArgs,
	stableStringify,
	validateTraceRecord,
} from "../evals/harness/trace.mjs";

const SCN = "C1-defect-pure";

test("stableStringify sorts object keys recursively", () => {
	assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
	assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("digestArgs is stable and hard-truncated to the schema maxLength", () => {
	assert.equal(digestArgs({ b: 1, a: 2 }), digestArgs({ a: 2, b: 1 }));
	const long = digestArgs("x".repeat(500));
	assert.ok(long.length <= 200, `expected <=200, got ${long.length}`);
	assert.ok(long.endsWith("…"));
});

test("TraceRecorder emits schema-valid records and round-trips JSONL", () => {
	const rec = new TraceRecorder({ agent: "test", scenario: SCN, dispatchId: "d-1" });
	rec.record({ role: "env-check", args: { runner: "jest" }, outcome: "ok", durationMs: 12 });
	rec.record({ role: "run-suite", args: "npm test", outcome: "error", durationMs: 800, files: ["a.test.js"] });
	const lines = rec.toJSONL().split("\n");
	assert.equal(lines.length, 2);
	for (const line of lines) assert.ok(validateTraceRecord(JSON.parse(line)).ok);

	const parsed = TraceRecorder.fromJSONL(rec.toJSONL());
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0].scenario, SCN);
	assert.equal(parsed[0].agent, "test");
	assert.equal(parsed[0].dispatchId, "d-1");
	assert.equal(parsed[1].files[0], "a.test.js");
});

test("TraceRecorder throws on an invalid record by default", () => {
	const rec = new TraceRecorder({ agent: "test", scenario: "not-a-scenario" });
	assert.throws(
		() => rec.record({ role: "env-check", outcome: "ok" }),
		(err) => err instanceof TraceValidationError && /scenario/.test(err.message),
	);
});

test("TraceRecorder collect mode keeps invalid records for diagnostics", () => {
	const rec = new TraceRecorder({ agent: "test", scenario: SCN, onInvalid: "collect" });
	rec.record({ role: "env-check", outcome: "not-an-outcome" });
	assert.equal(rec.errors.length, 1);
	assert.equal(rec.records.length, 1);
});

test("fromJSONL rejects a partially traced run rather than scoring it", () => {
	const bad = JSON.stringify({ ts: "2026-01-01T00:00:00Z", scenario: SCN, agent: "test", role: "x", outcome: "bogus" });
	assert.throws(() => TraceRecorder.fromJSONL(bad), TraceValidationError);
	assert.throws(() => TraceRecorder.fromJSONL("{not json}"), TraceValidationError);
});
