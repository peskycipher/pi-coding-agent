import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";

import { IoHarness, InMemoryLedger, type HarnessEvent } from "../shared/io.ts";
import { ScriptedRunner, ScoutToolShim, PiRunner } from "../shared/shim.ts";
import { checkDispatch, checkResult } from "../shared/wire.ts";

const WS = path.join(new URL("../", import.meta.url).pathname, "evals/fixtures/scout-ws");

const validResult = {
	verdicts: [{ candidate: "src/server.js", verdict: "include", why: "declares the HTTP surface" }],
	findings: [
		{ claim: "Service exposes GET /v1/widgets and GET /v1/widgets/:id", citation: "src/server.js:2-3", confidence: "high" },
		{ claim: "POST /v1/widgets requires an API key", citation: "src/server.js:4", confidence: "high" },
	],
	verdict_stats: { included: 3, summarized: 0, excluded: 1, unreachable: 0 },
	gaps: ["DELETE /v1/widgets/:id appears in code but not docs/api.md (doc drift candidate)"],
	handoff: { next_stage: "report-to-user", payload: "Endpoint inventory complete: 4 routes across src/server.js; docs/api.md lists 3 (drift on delete route)." },
};
const objective = "List every HTTP endpoint declared in this workspace with file:line citations";

function harness(runner) {
	const store = new InMemoryLedger();
	const events: HarnessEvent[] = [];
	const h = new IoHarness({ ledger: store, emit: (e) => events.push(e), runner });
	return { h, store, events };
}

test("happy path: research task settles with a contract-valid scout RESULT and full ledger trail", async () => {
	const { h, store, events } = harness(new ScriptedRunner(validResult));
	const payload = await h.runTask({ task_ref: "t-scout-1", goal: objective });
	assert.equal((payload as { summary: string }).summary.includes("scout findings accepted"), true);
	// event sequence: status → status(dispatch) → completion
	assert.deepEqual(events.map((e) => e.type), ["status", "status", "completion"]);
	// ledger trail: TASK → DISPATCH → RESULT → DECISION(settled), EO-stamped seqs
	const kinds = store.entries().map((e) => e.kind);
	assert.deepEqual(kinds, ["TASK", "DISPATCH", "RESULT", "DECISION"]);
	assert.ok(store.entries().every((e) => typeof e.seq === "number" && e.seq! > 0));
	// dispatch record wire-valid
	const dispatch = store.entries().find((e) => e.kind === "DISPATCH");
	const wire = checkDispatch({
		dispatch_id: "d-1", specialist: "scout", task_ref: "t-scout-1", instruction: dispatch!.summary,
		input: { goal: objective }, requires_tools: ["glob", "grep", "read"],
		budget: { tool_calls: 15, seconds: 300 }, reply_expected: "RESULT",
	});
	assert.ok(wire.ok);
	// RESULT payload contract-valid
	const res = checkResult({ specialist: "scout", result: validResult });
	assert.ok(res.ok);
});

test("idempotent re-ask: same task_ref answers from the ledger without re-dispatching", async () => {
	const { h, store } = harness(new ScriptedRunner(validResult));
	const first = await h.runTask({ task_ref: "t-scout-1", goal: objective });
	const before = store.entries().length;
	const again = await h.runTask({ task_ref: "t-scout-1", goal: objective });
	assert.deepEqual(again, first);  // same settlement, rebuilt from the ledger
	assert.equal(store.entries().length, before);
});

test("contract violation: one re-formed retry passes; attempt trail is honest", async () => {
	let calls = 0;
	const flaky = new ScriptedRunner(() => {
		calls++;
		return calls === 1
			? { verdicts: "not-a-list", findings: [] }      // schema-invalid shape
			: { ...validResult, verdicts: [...validResult.verdicts] };
	});
	const { h, store, events } = harness(flaky);
	const payload = await h.runTask({ task_ref: "t-retry-1", goal: objective });
	assert.ok((payload as { summary: string }).summary.includes("attempt 2"));
	const dispatches = store.entries().filter((e) => e.kind === "DISPATCH");
	assert.equal(dispatches.length, 2);
	assert.equal(dispatches[1].status, "resent-reformed"); // re-formed payload, ledgered
	assert.equal(events.filter((e) => e.type === "completion").length, 1);
});

test("double failure: research shape cannot degrade without scout — FAILURE with evidence + recoveryOptions", async () => {
	const { h, store } = harness(new ScriptedRunner({ verdicts: [] })); // findings/gaps/handoff missing
	const payload = await h.runTask({ task_ref: "t-fail-1", goal: objective }) as { classification: string; attempts: number; recoveryOptions: string[] };
	assert.equal(payload.classification, "specialist-failed");
	assert.equal(payload.attempts, 2);
	assert.deepEqual(payload.recoveryOptions, ["re-dispatch:scout", "clarify"]);
	assert.ok(store.entries().at(-1)!.status.startsWith("settled-failure"));
});

test("implement shape: scout -> plan -> gate -> build -> test runs end to end", async () => {
	const seen: string[] = [];
	const runner = new ScriptedRunner((d) => {
		seen.push(d.specialist);
		switch (d.specialist) {
			case "scout": return validResult;
			case "plan": return {
				steps: [{ id: "S1", action: "Implement the endpoint", tool_role: "workspace-edit", done_when: "endpoint responds", binds: "$endpoint" }],
				assumptions: [{ statement: "the endpoint is public", status: "unverified" }],
				parallel_groups: [],
				single_points_of_failure: ["S1"],
			};
			case "steelman": return {
				goal: d.input.goal,
				proposal: "strengthened endpoint plan",
				premises: [{ claim: "the endpoint is reachable", basis: "assumed" }],
				preempted_objections: [],
				open_problems: [],
			};
			case "contrarian": return { verdict: "APPROVED" };
			case "build": return {
				outcome: "green",
				changed_files: ["src/server.js"],
				verification_evidence: [{ check: "npm test -- server", exit: 0 }],
				lanes_used: [],
				notes: "endpoint added",
			};
			case "test": return {
				verdicts: [{ testId: "suite/server", class: "pass", evidence: "exited 0" }],
				first_attempt_pass_rate: 1,
				attested: ["layer 1 shell"],
				not_attested: [],
				gaps: [],
			};
			default: return {};
		}
	});
	const { h, store, events } = harness(runner);
	const payload = await h.runTask({ task_ref: "t-impl-1", goal: "build the endpoint", shape: "implement" }) as { summary: string; artifactRefs: string[] };
	assert.match(payload.summary, /implement pipeline settled/);
	assert.deepEqual(payload.artifactRefs, ["src/server.js"]);
	assert.deepEqual(seen, ["scout", "plan", "steelman", "contrarian", "build", "test"]);
	assert.ok(store.entries().at(-1)!.status.startsWith("settled-completion"));
	assert.equal(events.at(-1)!.type, "completion");
});

test("scout tool shim: real read-only roles execute against the fixture workspace", () => {
	const shim = new ScoutToolShim(WS, { tool_calls: 15 });
	shim.glob("*");
	const routes = shim.grep("v1/widgets");
	assert.ok(routes.length >= 5);
	const src = shim.read("src/server.js");
	assert.ok(src.includes("POST /v1/widgets"));
	assert.ok(shim.consumedToolCalls === 3 && !shim.budgetExhausted);
	assert.deepEqual(shim.trace.map((t) => t.role), ["glob", "grep", "read"]);
	assert.ok(shim.trace.every((t) => t.outcome === "ok" && typeof t.durationMs === "number"));
});

test("PiRunner is wired to the machine pi CLI (live verification gated behind PI_EVAL_LIVE)", { skip: !process.env.PI_EVAL_LIVE }, async () => {
	const runner = new PiRunner({ model: process.env.PI_EVAL_MODEL });
	const dispatch = {
		dispatch_id: "d-live-1", specialist: "scout" as const, task_ref: "t-live-1",
		instruction: "Research the objective", input: { goal: objective }, requires_tools: ["glob", "grep", "read"],
		budget: { tool_calls: 15, seconds: 300 }, reply_expected: "RESULT" as const,
	};
	const raw = await runner.run(dispatch);
	const check = checkResult({ specialist: "scout", result: raw });
	if (!check.ok) console.error("live contract violations:", check.errors);
	assert.ok(check.ok, "live scout run must produce a schema-valid RESULT");
	const res = (raw as { findings: unknown[] });
	assert.ok(Array.isArray(res.findings) && res.findings.length > 0, "live run found the endpoints");
});
