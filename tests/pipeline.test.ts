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

// --- implement-pipeline fixtures (contract-valid for scout/plan/build/test) ---

const scoutResult = {
	verdicts: [{ candidate: "src/widget.ts", verdict: "include", why: "declares the widget API" }],
	findings: [{ claim: "src/widget.ts declares the widget API", citation: "src/widget.ts:1", confidence: "high" }],
	verdict_stats: { included: 1, summarized: 0, excluded: 0, unreachable: 0 },
	gaps: [],
	handoff: { next_stage: "implement", payload: "widget API lives at src/widget.ts" },
};

const planResult = {
	steps: [
		{ id: "S1", action: "Implement the widget module", tool_role: "workspace-edit", done_when: "module committed", binds: "$widget" },
		{ id: "S2", action: "Run the widget checks", tool_role: "run-check", depends_on: ["S1"], done_when: "checks exit 0", binds: "$verified" },
	],
	assumptions: [{ statement: "the widget API is public", status: "unverified" }],
	parallel_groups: [],
	single_points_of_failure: ["S1"],
};

const buildResult = {
	outcome: "green",
	changed_files: ["src/widget.ts"],
	verification_evidence: [{ check: "npm test -- widget", exit: 0 }],
	lanes_used: ["repair"],
	notes: "implemented the widget module",
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

/** Scripted implement pipeline; per-specialist overrides receive the DISPATCH record. */
function implementRunner(overrides: Partial<Record<DispatchRecord["specialist"], (d: DispatchRecord) => unknown>> = {}) {
	const seen: DispatchRecord[] = [];
	const runner: SpecialistRunner = {
		async run(dispatch) {
			seen.push(dispatch);
			const override = overrides[dispatch.specialist];
			if (override) return override(dispatch);
			switch (dispatch.specialist) {
				case "scout": return scoutResult;
				case "plan": return planResult;
				case "steelman": return { ...steel, goal: dispatch.input.goal };
				case "contrarian": return { verdict: "APPROVED" };
				case "build": return buildResult;
				case "test": return testResult;
				default: return {};
			}
		},
	};
	return { runner, seen };
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

test("implement shape: scout -> plan -> gate(approved) -> build -> test settles green", async () => {
	const { runner, seen } = implementRunner();
	const { h, ledger, events, metrics } = harness(runner);
	const payload = await h.runTask({ task_ref: "i-1", goal: "build the widget", shape: "implement" }) as { summary: string; artifactRefs: string[] };
	assert.match(payload.summary, /implement pipeline settled/);
	assert.match(payload.summary, /plan gate-approved/);
	assert.deepEqual(payload.artifactRefs, ["src/widget.ts"]);
	assert.deepEqual(seen.map((d) => d.specialist), ["scout", "plan", "steelman", "contrarian", "build", "test"]);
	assert.ok(ledger.entries().some((e) => e.status === "gate-approved"));
	assert.equal(events.at(-1)!.type, "completion");
	assert.equal(metrics.value("agent_task_total", { agent: "io", outcome: "completion" }), 1);
	assert.equal(metrics.value("agent_loop_iterations_total", { agent: "io", gate: "adversarial" }), 1);
});

test("implement shape: plan and build results are handed forward to the next stage", async () => {
	const { runner, seen } = implementRunner();
	const { h } = harness(runner);
	await h.runTask({ task_ref: "i-handoff", goal: "build the widget", shape: "implement" });
	const planDispatch = seen.find((d) => d.specialist === "plan")!;
	assert.equal(planDispatch.input.goal, "build the widget");
	assert.ok(planDispatch.input.scout_findings && typeof planDispatch.input.scout_findings === "object");
	const buildDispatch = seen.find((d) => d.specialist === "build")!;
	assert.ok(buildDispatch.input.plan && typeof buildDispatch.input.plan === "object");
	const testDispatch = seen.find((d) => d.specialist === "test")!;
	assert.ok(testDispatch.input.build && typeof testDispatch.input.build === "object");
});

test("implement shape: mechanical facts can skip the gate and the skip is ledgered", async () => {
	const { runner, seen } = implementRunner();
	const { h, ledger, metrics } = harness(runner);
	const payload = await h.runTask({ task_ref: "i-skip", goal: "build the widget", shape: "implement", gate: {} }) as { summary: string };
	assert.match(payload.summary, /plan gate-skipped/);
	assert.deepEqual(seen.map((d) => d.specialist), ["scout", "plan", "build", "test"]);
	assert.equal(metrics.value("agent_gate_skipped_total", { gate: "adversarial" }), 1);
	assert.ok(ledger.entries().some((e) => e.status === "gate_skipped"));
});

test("implement shape: a REJECTED gate re-dispatches plan with the fatal flaws, then proceeds", async () => {
	const flawInputs: unknown[] = [];
	let contrarianCalls = 0;
	const { runner, seen } = implementRunner({
		plan: (d) => {
			if (d.input.fatal_flaws) flawInputs.push(d.input.fatal_flaws);
			return planResult;
		},
		contrarian: () => {
			contrarianCalls += 1;
			return contrarianCalls === 1
				? { verdict: "REJECTED", fatal_flaws: [{ claim: "S1 has no done criterion", breaks: "verification", why: "unverifiable step" }] }
				: { verdict: "APPROVED" };
		},
	});
	const { h, events } = harness(runner);
	const payload = await h.runTask({ task_ref: "i-revise", goal: "build the widget", shape: "implement" }) as { summary: string };
	assert.match(payload.summary, /plan gate-approved \(iteration 2\)/);
	assert.equal(seen.filter((d) => d.specialist === "plan").length, 2);
	assert.deepEqual(flawInputs, [[{ claim: "S1 has no done criterion", breaks: "verification", why: "unverifiable step" }]]);
	assert.equal(contrarianCalls, 2);
	assert.equal(events.at(-1)!.type, "completion");
});

test("implement shape: a gate that never approves fails upward with the flaw list", async () => {
	const { runner } = implementRunner({
		contrarian: () => ({ verdict: "REJECTED", fatal_flaws: [{ claim: "the plan is unfalsifiable", breaks: "objective", why: "no evidence path" }] }),
	});
	const { h, ledger, events, metrics } = harness(runner);
	const payload = await h.runTask({ task_ref: "i-capped", goal: "build the widget", shape: "implement" }) as { classification: string; evidence: string[]; recoveryOptions: string[] };
	assert.equal(payload.classification, "gate-failed");
	assert.ok(payload.evidence.some((e) => e.includes("iteration cap")));
	assert.ok(payload.evidence.some((e) => e.includes("the plan is unfalsifiable")));
	assert.deepEqual(payload.recoveryOptions, ["revise-plan", "clarify"]);
	assert.equal(events.filter((e) => e.type === "failure").length, 1);
	assert.ok(ledger.entries().some((e) => e.status === "settled-failure"));
	assert.equal(metrics.value("agent_task_total", { agent: "io", outcome: "failure" }), 1);
});

test("implement shape: gate protocol failure is a failure, not a throw", async () => {
	const { runner } = implementRunner({ contrarian: () => ({ nope: true }) });
	const { h } = harness(runner);
	const payload = await h.runTask({ task_ref: "i-proto", goal: "build the widget", shape: "implement" }) as { classification: string; recoveryOptions: string[] };
	assert.equal(payload.classification, "gate-failed");
	assert.deepEqual(payload.recoveryOptions, ["re-dispatch:gate", "clarify"]);
});

test("implement shape: scout failure fails upward and never dispatches plan", async () => {
	const { runner, seen } = implementRunner({ scout: () => ({ verdicts: [] }) });
	const { h } = harness(runner);
	const payload = await h.runTask({ task_ref: "i-scout-bad", goal: "build the widget", shape: "implement" }) as { classification: string; recoveryOptions: string[] };
	assert.equal(payload.classification, "specialist-failed");
	assert.deepEqual(payload.recoveryOptions, ["re-dispatch:scout", "clarify"]);
	assert.equal(seen.filter((d) => d.specialist !== "scout").length, 0);
});

test("implement shape: plan failure fails upward after scout grounded it", async () => {
	const { runner, seen } = implementRunner({ plan: () => ({ steps: [] }) });
	const { h } = harness(runner);
	const payload = await h.runTask({ task_ref: "i-plan-bad", goal: "build the widget", shape: "implement" }) as { recoveryOptions: string[] };
	assert.deepEqual(payload.recoveryOptions, ["re-dispatch:plan", "clarify"]);
	assert.equal(seen.filter((d) => d.specialist === "scout").length, 1);
	assert.equal(seen.filter((d) => d.specialist === "plan").length, 2);
});

test("implement shape: build failure fails upward with re-dispatch:build", async () => {
	const { runner } = implementRunner({ build: () => ({ outcome: "green" }) });
	const { h } = harness(runner);
	const payload = await h.runTask({ task_ref: "i-build-bad", goal: "build the widget", shape: "implement" }) as { recoveryOptions: string[] };
	assert.deepEqual(payload.recoveryOptions, ["re-dispatch:build", "clarify"]);
});

test("implement shape: test failure fails upward with re-dispatch:test", async () => {
	const { runner } = implementRunner({ test: () => ({ verdicts: [] }) });
	const { h } = harness(runner);
	const payload = await h.runTask({ task_ref: "i-test-bad", goal: "build the widget", shape: "implement" }) as { recoveryOptions: string[] };
	assert.deepEqual(payload.recoveryOptions, ["re-dispatch:test", "clarify"]);
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
