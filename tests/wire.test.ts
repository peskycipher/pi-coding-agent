import assert from "node:assert/strict";
import { test } from "node:test";

import {
	checkEnvelope,
	checkResult,
	checkDispatch,
	checkLedgerEntry,
} from "../shared/wire.ts";

// Case names with "(must reject)" are the deliberate violations called out in the
// assessment; every other case is the documented protocol-shape minimum.

function frame(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
	return {
		v: 1,
		id: "msg-1",
		ref: "task-1",
		ts: "2026-01-01T00:00:00Z",
		from: "external",
		to: "internal",
		type,
		task_ref: "t-1",
		...extra,
		payload,
	};
}

const TASK_PAYLOAD = {
	goal: "g",
	constraints: {},
	sandbox: { tools: [], budgets: {}, network: "none" },
	budget: { wall_clock_task: null, tokens_task: null },
	session: { ledgerRef: "", artifactsDir: "" },
};

test("envelope: valid COMPLETION", () => {
	assert.ok(
		checkEnvelope(
			frame("COMPLETION", { summary: "s", verdictAttenuations: [], artifactRefs: [], ledgerRef: "l" }, { to: "external" }),
		).ok,
	);
});

test("envelope: COMPLETION missing verdictAttenuations is rejected", () => {
	assert.ok(!checkEnvelope(
		frame("COMPLETION", { summary: "s", artifactRefs: [], ledgerRef: "l" }, { to: "external" }),
	).ok);
});

test("envelope: INTERRUPT reasons are an enum", () => {
	assert.ok(checkEnvelope(frame("INTERRUPT", { reason: "teardown" })).ok);
	assert.ok(!checkEnvelope(frame("INTERRUPT", { reason: "meh" })).ok);
});

test("envelope: ARTIFACT_REQUEST needs url or descriptor, always whyEgressNeeded + expectedSize", () => {
	assert.ok(checkEnvelope(frame("ARTIFACT_REQUEST", { url: "https://x/y", whyEgressNeeded: "w", expectedSize: 100 })).ok);
	assert.ok(!checkEnvelope(frame("ARTIFACT_REQUEST", { whyEgressNeeded: "w", expectedSize: 100 })).ok);
});

test("envelope: task_ref is required on every type except NAK", () => {
	const { task_ref: _drop, ...withoutRef } = frame("TASK", TASK_PAYLOAD) as Record<string, unknown>;
	assert.ok(!checkEnvelope(withoutRef).ok);
	const nak = frame("NAK", { error: "e", receivedType: "TASK" }) as Record<string, unknown>;
	delete (nak as { task_ref?: string }).task_ref;
	assert.ok(checkEnvelope(nak).ok);
});

test("envelope: version mismatch and unknown type are rejected", () => {
	const badV = { ...frame("INTERRUPT", { reason: "user" }), v: 2 };
	assert.ok(!checkEnvelope(badV).ok);
	assert.ok(!checkEnvelope(frame("BOGUS", {})).ok);
});

test("result: contrarian verdicts", () => {
	assert.ok(checkResult({ specialist: "contrarian", result: { verdict: "APPROVED" } }).ok);
	assert.ok(!checkResult({
		specialist: "contrarian",
		result: { verdict: "APPROVED", fatal_flaws: [{ claim: "c", breaks: "b", why: "w" }] },
	}).ok);
	assert.ok(!checkResult({ specialist: "contrarian", result: { verdict: "REJECTED" } }).ok);
	assert.ok(checkResult({
		specialist: "contrarian",
		result: { verdict: "REJECTED", fatal_flaws: [{ claim: "c", breaks: "b", why: "w" }] },
	}).ok);
	assert.ok(checkResult({
		specialist: "contrarian",
		result: { verdict: "PROTOCOL_INVALID", protocol_invalid_reason: "contamination" },
	}).ok);
});

test("result: specialist tag binds the payload shape (no cross-specialist payloads)", () => {
	assert.ok(!checkResult({
		specialist: "contrarian",
		result: { verdicts: [{ verdict: "exclude" }], findings: [], gaps: [], handoff: { next_stage: "verify", payload: "" } },
	}).ok);
});

test("result: scout contract (verdict-stats and phase included)", () => {
	assert.ok(checkResult({
		specialist: "scout",
		result: {
			verdicts: [{ verdict: "include" }],
			findings: [{ claim: "c", citation: "a.ts:1", confidence: "high", phase: "conflict" }],
			verdict_stats: { included: 2, summarized: 1, excluded: 3, unreachable: 0 },
			gaps: ["g"],
			handoff: { next_stage: "report-to-user", payload: "p" },
		},
	}).ok);
	assert.ok(!checkResult({ specialist: "scout", result: { verdicts: [], findings: [], gaps: [] } }).ok);
});

test("result: plan contract carries tool_role on steps", () => {
	assert.ok(checkResult({
		specialist: "plan",
		result: {
			steps: [{ id: "S1", action: "a", tool_role: "read", done_when: "d" }],
			assumptions: [{ statement: "s", status: "verified" }],
			parallel_groups: [],
			single_points_of_failure: [],
		},
	}).ok);
});

test("result: build requires executed-check evidence even when green", () => {
	assert.ok(!checkResult({
		specialist: "build",
		result: { outcome: "green", changed_files: [], verification_evidence: [], lanes_used: [], notes: "" },
	}).ok);
	assert.ok(checkResult({
		specialist: "build",
		result: { outcome: "green", changed_files: ["a.ts"], verification_evidence: [{ check: "npm test", exit: 0 }], lanes_used: [], notes: "" },
	}).ok);
});

test("result: steel-man RESULT and STRUCTURAL FLAG", () => {
	assert.ok(checkResult({
		specialist: "steelman",
		result: { goal: "g", proposal: "p", premises: [{ claim: "c", basis: "assumed" }], preempted_objections: [], open_problems: [] },
	}).ok);
	assert.ok(checkResult({ specialist: "steelman", result: { structural_flag: { reason: "r" } } }).ok);
});

test("dispatch: record shape with role inventory and budget", () => {
	assert.ok(checkDispatch({
		dispatch_id: "d-1",
		specialist: "scout",
		task_ref: "t1",
		instruction: "i",
		input: { goal: "g" },
		requires_tools: ["read"],
		budget: { tool_calls: 15, seconds: 300 },
		reply_expected: "RESULT",
	}).ok);
	assert.ok(!checkDispatch({
		dispatch_id: "d-1",
		specialist: "scout",
		task_ref: "t1",
		instruction: "i",
		input: { goal: "g" },
		requires_tools: ["read"],
		budget: { tool_calls: 15 },
		reply_expected: "RESULT",
	}).ok);
});

test("ledger: entry with EO-assigned seq (null at write time)", () => {
	assert.ok(checkLedgerEntry({
		seq: null, ts: "2026-01-01T00:00:00Z", kind: "DISPATCH", ref: "d-1", trace_id: "t1", summary: "s", status: "sent",
	}).ok);
	assert.ok(!checkLedgerEntry({
		seq: null, ts: "2026-01-01T00:00:00Z", kind: "TRANSCRIPT", ref: "d-1", trace_id: "t1", summary: "s", status: "x",
	}).ok);
});

// Negative probes of the FAILURE PATH itself: the drift-check negative probe exercises
// the schema files, not this module — here the wrapper must return actionable errors
// (non-empty, kind-prefixed, naming the failing constraint) — the protocol's NAK error
// field and the runbooks depend on that shape.
test("failure shape: every check returns kind-prefixed, non-empty errors naming the constraint", () => {
	for (const [check, bad] of [
		[checkEnvelope, frame("COMPLETION", { summary: "s", artifactRefs: [], ledgerRef: "l" }, { to: "external" })],
		[checkEnvelope, { ...frame("INTERRUPT", { reason: "user" }), v: 7 }],
		[checkEnvelope, frame("BOGUS", {})],
		[checkResult, { specialist: "contrarian", result: { verdict: "REJECTED" } }],
		[checkResult, { specialist: "nope", result: {} }],
		[checkDispatch, { dispatch_id: "d-1", specialist: "scout", task_ref: "t1", instruction: "i", input: {}, requires_tools: [], budget: { tool_calls: 1 }, reply_expected: "RESULT" }],
		[checkLedgerEntry, { seq: null, ts: "nope", kind: "DISPATCH", ref: "d-1", trace_id: "t1", summary: "s", status: "x" }],
	] as const) {
		const res = check(bad as unknown);
		assert.ok(!res.ok, "expected rejection");
		assert.ok(res.errors.length > 0, "errors must not be empty");
		const expected = check === checkEnvelope ? "envelope" : check === checkResult ? "result"
			: check === checkDispatch ? "dispatch" : "ledger";
		for (const e of res.errors) {
			assert.ok(typeof e === "string" && e.length > 0, "errors must be non-empty strings");
			assert.ok(e.startsWith(`${expected}: `), `error must be kind-prefixed ("${expected}:"), got: ${e}`);
		}
	}
});

test("failure shape: version mismatch and unknown type point at the failing envelope field", () => {
	const badV = checkEnvelope({ ...frame("INTERRUPT", { reason: "user" }), v: 2 }) as { ok: false; errors: string[] };
	assert.ok(badV.errors.some((e) => e.includes('"/v"') && e.includes('"const"')), `v mismatch must point at /v and the const constraint: ${badV.errors[0]}`);
	const badType = checkEnvelope(frame("BOGUS", {})) as { ok: false; errors: string[] };
	assert.ok(badType.errors.some((e) => e.includes('"/type"') && e.includes('"enum"')), `unknown type must point at /type and the enum constraint: ${badType.errors[0]}`);
});