import assert from "node:assert/strict";
import { test } from "node:test";

import { IoHarness, InMemoryLedger, type DispatchRecord, type HarnessEvent, type SpecialistRunner } from "../shared/io.ts";
import { MemoryLogSink, Metrics } from "../shared/telemetry.ts";
import type { SteelManResult } from "../shared/adversarial.ts";

const testResult = {
	verdicts: [{ testId: "suite/parser", class: "pass", evidence: "npm test exited 0" }],
	first_attempt_pass_rate: 1,
	attested: ["layer 1 shell"],
	not_attested: [],
	gaps: [],
};

const docsResult = {
	doc_updates: [],
	claims_index_delta: [],
	verdict: {
		attested: ["docs/api.md"],
		stale_sections: [{ path: "docs/cli.md#flags", risk: "wrong-instruction" }],
	},
};

const steel: SteelManResult = {
	goal: "g",
	proposal: "strong",
	premises: [{ claim: "p", basis: "assumed" }],
	preempted_objections: [],
	open_problems: [],
};

function runnerFrom(fn: (d: DispatchRecord) => unknown): SpecialistRunner {
	return { async run(d) { return fn(d); } };
}

function harness(runner: SpecialistRunner, opts: { metrics?: Metrics; logs?: MemoryLogSink } = {}) {
	const ledger = new InMemoryLedger();
	const events: HarnessEvent[] = [];
	const metrics = opts.metrics ?? new Metrics();
	const logs = opts.logs ?? new MemoryLogSink();
	const h = new IoHarness({ ledger, emit: (e) => events.push(e), runner, metrics, logs });
	return { h, ledger, events, metrics, logs };
}

test("verify-only shape: dispatches the test specialist and settles green", async () => {
	const { h, ledger, events, metrics } = harness(runnerFrom(() => testResult));
	const payload = await h.runTask({ task_ref: "v-1", goal: "verify the parser", shape: "verify-only", target: "abc123" }) as { summary: string };
	assert.match(payload.summary, /test verdicts accepted/);
	assert.deepEqual(events.map((e) => e.type), ["status", "status", "completion"]);
	assert.deepEqual(ledger.entries().map((e) => e.kind), ["TASK", "DISPATCH", "RESULT", "DECISION"]);
	assert.equal(metrics.value("agent_task_total", { agent: "io", outcome: "completion" }), 1);
});

test("docs-drift shape: emits a stale-claim metric per risk class", async () => {
	const { h, events, metrics, logs } = harness(runnerFrom(() => docsResult));
	const payload = await h.runTask({ task_ref: "d-1", goal: "check docs", shape: "docs-drift" }) as { summary: string };
	assert.match(payload.summary, /docs docs-drift result accepted/);
	assert.equal(events.at(-1)!.type, "completion");
	assert.equal(metrics.value("agent_docs_stale_claims_total", { risk_class: "wrong-instruction" }), 1);
	assert.ok(logs.records.some((r) => r.event === "docs_drift_detected"));
});

test("docs contract violation: re-formed retry, then honest specialist failure", async () => {
	const { h, ledger, events, metrics } = harness(runnerFrom(() => ({ doc_updates: "nope" })));
	const payload = await h.runTask({ task_ref: "d-bad", goal: "check docs", shape: "docs-drift" }) as { classification: string; recoveryOptions: string[]; attempts: number };
	assert.equal(payload.classification, "specialist-failed");
	assert.equal(payload.attempts, 2);
	assert.deepEqual(payload.recoveryOptions, ["re-dispatch:docs", "clarify"]);
	assert.equal(metrics.value("agent_contract_violations_total", { specialist: "docs" }), 2);
	assert.equal(events.filter((e) => e.type === "failure").length, 1);
	assert.ok(ledger.entries().at(-1)!.status.startsWith("settled-failure"));
});

test("implement shape stays unimplemented and fails honestly", async () => {
	const { h } = harness(runnerFrom(() => testResult));
	const payload = await h.runTask({ task_ref: "i-1", goal: "build it", shape: "implement" }) as { classification: string; recoveryOptions: string[] };
	assert.equal(payload.classification, "pipeline-unimplemented");
	assert.deepEqual(payload.recoveryOptions, ["revise-task: research"]);
});

test("runGate: skip decision is ledgered and counted, never silent", async () => {
	const { h, ledger, metrics, logs } = harness(runnerFrom(() => steel));
	const result = await h.runGate({ task_ref: "g-skip", goal: "g" }, { goal: "g", proposal: "p", facts: {} });
	assert.equal(result.attached, false);
	assert.equal(metrics.value("agent_gate_skipped_total", { gate: "adversarial" }), 1);
	assert.ok(ledger.entries().some((e) => e.status === "gate_skipped"));
	assert.ok(logs.records.some((r) => r.event === "gate_skipped"));
});

test("runGate: attached gate loops, ledgering each iteration", async () => {
	let steelmanSeen = 0;
	const runner = runnerFrom((d) => {
		if (d.specialist === "steelman") {
			steelmanSeen += 1;
			return steel;
		}
		return { verdict: "APPROVED" };
	});
	const { h, ledger, metrics } = harness(runner);
	const result = await h.runGate({ task_ref: "g-attach", goal: "g" }, { goal: "g", proposal: "p", facts: { publishShaped: true } });
	assert.equal(result.attached, true);
	assert.equal(result.kind, "approved");
	assert.equal(steelmanSeen, 1);
	assert.ok(ledger.entries().some((e) => e.ref === "gate-iter-1" && e.status === "gate-approved"));
	assert.equal(metrics.value("agent_loop_iterations_total", { agent: "io", gate: "adversarial" }), 1);
});

test("runGate: dispatch failure inside the gate yields protocol-invalid, not a throw", async () => {
	const { h } = harness(runnerFrom(() => ({})));
	const result = await h.runGate({ task_ref: "g-bad", goal: "g" }, { goal: "g", proposal: "p" });
	assert.equal(result.attached, true);
	assert.equal(result.kind, "protocol-invalid");
});
