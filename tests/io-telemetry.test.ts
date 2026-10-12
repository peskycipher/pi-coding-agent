// Live-producer tests for the observability emitters wired into shared/io.ts.
//
// The unit tests in telemetry.test.ts prove the Metrics/LogSink primitives; the alert
// tests in alerts.test.ts prove the rule engine over hand-built fixtures. This file is the
// missing middle: it drives the real IO harness dispatch and gate paths and asserts the
// emitters fire, then feeds the resulting projections (metrics + JSONL + ledger) straight
// into evaluateAlerts so the alert rules consume live signal, not fixtures only.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AlertLedgerEvent } from "../shared/alerts.ts";
import { evaluateAlerts } from "../shared/alerts.ts";
import { InMemoryLedger, IoHarness, type DispatchRecord, type HarnessEvent, type SpecialistRunner } from "../shared/io.ts";
import { ScriptedRunner } from "../shared/shim.ts";
import { MemoryLogSink, Metrics } from "../shared/telemetry.ts";

const NOW = "2026-01-02T00:00:00.000Z";

const validScout = {
	verdicts: [{ candidate: "src/widget.ts", verdict: "include", why: "declares the widget API" }],
	findings: [{ claim: "src/widget.ts declares the widget API", citation: "src/widget.ts:1", confidence: "high" }],
	verdict_stats: { included: 1, summarized: 0, excluded: 0, unreachable: 0 },
	gaps: [],
	handoff: { next_stage: "implement", payload: "widget API lives at src/widget.ts" },
};

const validPlan = {
	steps: [{ id: "S1", action: "Implement the widget", tool_role: "workspace-edit", done_when: "module committed", binds: "$widget" }],
	assumptions: [{ statement: "the widget API is public", status: "unverified" }],
	parallel_groups: [],
	single_points_of_failure: ["S1"],
};

const validBuild = {
	outcome: "green",
	changed_files: ["src/widget.ts"],
	verification_evidence: [{ check: "npm test -- widget", exit: 0 }],
	lanes_used: [],
	notes: "implemented the widget",
};

const validTest = {
	verdicts: [{ testId: "suite/widget", class: "pass", evidence: "exited 0" }],
	first_attempt_pass_rate: 1,
	attested: ["layer 1 shell"],
	not_attested: [],
	gaps: [],
};

/** Scripted implement pipeline, with per-specialist overrides. */
function implementRunner(overrides: Partial<Record<DispatchRecord["specialist"], (d: DispatchRecord) => unknown>> = {}): SpecialistRunner {
	return {
		async run(dispatch) {
			const override = overrides[dispatch.specialist];
			if (override) return override(dispatch);
			switch (dispatch.specialist) {
				case "scout": return validScout;
				case "plan": return validPlan;
				case "steelman": return { goal: dispatch.input.goal, proposal: "strengthened", premises: [{ claim: "p", basis: "assumed" }], preempted_objections: [], open_problems: [] };
				case "contrarian": return { verdict: "APPROVED" };
				case "build": return validBuild;
				case "test": return validTest;
				default: return {};
			}
		},
	};
}

function setup(runner: SpecialistRunner, extra: Partial<ConstructorParameters<typeof IoHarness>[0]> = {}) {
	const ledger = new InMemoryLedger();
	const logs = new MemoryLogSink();
	const metrics = new Metrics();
	const events: HarnessEvent[] = [];
	const h = new IoHarness({ ledger, emit: (e) => events.push(e), runner, metrics, logs, ...extra });
	return { h, ledger, logs, metrics, events };
}

test("ledger_appended: every ledger write emits a structured record carrying its kind", async () => {
	const { h, ledger, logs } = setup(new ScriptedRunner(validScout));
	await h.runTask({ task_ref: "tl-1", goal: "list the widget surface" });

	const appends = logs.records.filter((r) => r.event === "ledger_appended");
	assert.equal(appends.length, ledger.entries().length);
	assert.deepEqual(appends.map((r) => r.kind), ledger.entries().map((e) => e.kind));
	assert.ok(appends.every((r) => r.trace_id === "tl-1" && r.entry_point === "internal"));
	assert.deepEqual(appends.map((r) => r.kind), ["TASK", "DISPATCH", "RESULT", "DECISION"]);
});

test("tool calls + overrun: the toolCalls record feeds agent_tool_calls_total and agent_budget_overrun_total", async () => {
	const toolCalls = () => [{ role: "read", count: 3 }, { role: "grep", count: 20 }];
	const { h, metrics } = setup(new ScriptedRunner(validScout), { toolCalls });
	await h.runTask({ task_ref: "tt-1", goal: "list the widget surface" });

	assert.equal(metrics.value("agent_tool_calls_total", { agent: "scout", tool_role: "read" }), 3);
	assert.equal(metrics.value("agent_tool_calls_total", { agent: "scout", tool_role: "grep" }), 20);
	// 23 tool calls > the default DISPATCH budget of 15: exactly one overrunning dispatch.
	assert.equal(metrics.value("agent_budget_overrun_total", { agent: "scout" }), 1);
});

test("heartbeat + wall-clock budget: a dispatch outliving the interval emits heartbeat_missed, age and overrun", async () => {
	let clock = 0;
	const slow: SpecialistRunner = {
		async run() {
			clock += 420_000; // 420 s: past the 30 s heartbeat and the 300 s dispatch budget
			return validScout;
		},
	};
	const { h, logs, metrics } = setup(slow, { nowMs: () => clock });
	await h.runTask({ task_ref: "th-1", goal: "list the widget surface" });

	const missed = logs.records.filter((r) => r.event === "heartbeat_missed");
	assert.equal(missed.length, 1);
	assert.equal(missed[0]!.agent, "internal");
	assert.equal(missed[0]!.age_seconds, 420);
	assert.equal(missed[0]!.dispatch_id, "d-1");
	assert.equal(metrics.value("agent_heartbeat_age_seconds", { agent: "internal" }), 420);
	assert.equal(metrics.value("agent_budget_overrun_total", { agent: "scout" }), 1);
});

test("NAK: a malformed RESULT counts an internal NAK; recordNak records the external side", async () => {
	const { h, metrics } = setup(new ScriptedRunner({ verdicts: [] }));
	await h.runTask({ task_ref: "tn-1", goal: "list the widget surface" });

	// two attempts, both contract-invalid → two internal NAKs
	assert.equal(metrics.value("agent_nak_total", { side: "internal" }), 2);
	h.recordNak("external");
	assert.equal(metrics.value("agent_nak_total", { side: "external" }), 1);
});

test("approval granted: the [approval] stage observes approval_wait_seconds and logs request/grant", async () => {
	const { h, logs, metrics, ledger } = setup(implementRunner(), {
		approval: async () => ({ granted: true, waitSeconds: 2000, scope: "build" }),
		now: () => NOW,
	});
	const payload = await h.runTask({ task_ref: "ta-1", goal: "build the widget", shape: "implement" }) as { summary: string };

	assert.match(payload.summary, /implement pipeline settled/);
	assert.equal(metrics.value("approval_wait_seconds"), 2000);
	assert.equal(logs.records.filter((r) => r.event === "approval_requested").length, 1);
	assert.equal(logs.records.filter((r) => r.event === "approval_granted").length, 1);

	// the alert engine consumes the live histogram, not a fixture
	const findings = evaluateAlerts({ now: NOW, metrics: metrics.snapshot(), logs: logs.records, ledger: ledger.entries() });
	assert.ok(findings.some((f) => f.name === "approval_wait_sla" && f.severity === "ticket"));
});

test("approval denied: logs approval_denied and settles as a non-specialist failure", async () => {
	const { h, logs, metrics, events } = setup(implementRunner(), {
		approval: async () => ({ granted: false, waitSeconds: 10, scope: "publish" }),
		now: () => NOW,
	});
	const payload = await h.runTask({ task_ref: "ta-2", goal: "build the widget", shape: "implement" }) as { classification: string; recoveryOptions: string[] };

	assert.equal(payload.classification, "approval-denied");
	assert.deepEqual(payload.recoveryOptions, ["revise-scope", "clarify"]);
	assert.equal(logs.records.filter((r) => r.event === "approval_denied").length, 1);
	assert.equal(metrics.value("agent_task_total", { agent: "io", outcome: "failure" }), 1);
	assert.equal(events.at(-1)!.type, "failure");
});

test("gate REJECTED: real ledger DECISION entries drive adversarial_rejection_rate", async () => {
	const runner: SpecialistRunner = {
		async run(d) {
			return d.specialist === "steelman"
				? { goal: d.input.goal, proposal: "strengthened", premises: [{ claim: "p", basis: "assumed" }], preempted_objections: [], open_problems: [] }
				: { verdict: "REJECTED", fatal_flaws: [{ claim: "unfalsifiable", breaks: "objective", why: "no evidence path" }] };
		},
	};
	const { h, ledger } = setup(runner, { now: () => NOW });
	const result = await h.runGate({ task_ref: "tg-1", goal: "g" }, { goal: "g", proposal: "p", iterationCap: 1 });

	assert.equal(result.attached, true);
	assert.equal(result.kind, "capped");
	assert.equal(ledger.entries().filter((e) => e.status === "gate-rejected").length, 1);

	const findings = evaluateAlerts({ now: NOW, metrics: h.metrics.snapshot(), logs: [], ledger: ledger.entries() as AlertLedgerEvent[] });
	assert.ok(findings.some((f) => f.name === "adversarial_rejection_rate"));
});

test("live projections: a slow contract-violating runner fires contract_violation_rate and pipeline_stalled", async () => {
	let clock = 0;
	const slowBad: SpecialistRunner = {
		async run() {
			clock += 420_000;
			return { verdicts: [] }; // schema-invalid: no findings/gaps/handoff
		},
	};
	const { h, logs, metrics } = setup(slowBad, { nowMs: () => clock, now: () => NOW });
	const payload = await h.runTask({ task_ref: "tf-1", goal: "list the widget surface" }) as { classification: string; recoveryOptions: string[] };

	assert.equal(payload.classification, "specialist-failed");
	assert.deepEqual(payload.recoveryOptions, ["re-dispatch:scout", "clarify"]);
	// lane exhausted rides the log with non-empty recoveryOptions, so no false page
	assert.equal(metrics.value("agent_nak_total", { side: "internal" }), 2);

	const findings = evaluateAlerts({ now: NOW, metrics: metrics.snapshot(), logs: logs.records });
	assert.ok(findings.some((f) => f.name === "contract_violation_rate"));
	assert.ok(findings.some((f) => f.name === "pipeline_stalled"));
	assert.deepEqual(findings.filter((f) => f.severity === "page").map((f) => f.name), ["pipeline_stalled"]);
});
