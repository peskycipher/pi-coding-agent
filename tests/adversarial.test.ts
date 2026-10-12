import assert from "node:assert/strict";
import { test } from "node:test";

import {
	decideGateAttach,
	runAdversarialGate,
	type GateRunner,
	type SteelManResult,
} from "../shared/adversarial.ts";

const STEEL_1: SteelManResult = {
	goal: "ship it",
	proposal: "strong-1",
	premises: [{ claim: "p1", basis: "assumed" }],
	preempted_objections: [],
	open_problems: [],
};

function queued(responses: unknown[]): { runner: GateRunner; calls: { specialist: string; input: Record<string, unknown> }[] } {
	const calls: { specialist: string; input: Record<string, unknown> }[] = [];
	let i = 0;
	const runner: GateRunner = async (specialist, input) => {
		calls.push({ specialist, input: input as unknown as Record<string, unknown> });
		return responses[Math.min(i++, responses.length - 1)];
	};
	return { runner, calls };
}

test("gate attach: each mechanical criterion attaches; default skips and is ledgered", () => {
	assert.equal(decideGateAttach({ publishShaped: true }).attach, true);
	assert.equal(decideGateAttach({ parallelRoute: true }).attach, true);
	assert.equal(decideGateAttach({ capabilityMapModules: 3 }).attach, true);
	assert.equal(decideGateAttach({ daysSincePriorRejection: 3 }).attach, true);
	const skipped = decideGateAttach({});
	assert.equal(skipped.attach, false);
	assert.match(skipped.reason, /no attach criterion/);
});

test("gate: APPROVED on the first iteration", async () => {
	const { runner, calls } = queued([STEEL_1, { verdict: "APPROVED" }]);
	const outcome = await runAdversarialGate({ goal: "ship it", proposal: "original", runner });
	assert.equal(outcome.kind, "approved");
	if (outcome.kind !== "approved") return;
	assert.equal(outcome.iterations, 1);
	assert.deepEqual(outcome.premises, [{ claim: "p1", basis: "assumed" }]);
	assert.deepEqual(calls.map((c) => c.specialist), ["steelman", "contrarian"]);
});

test("gate: REJECTED -> revise -> APPROVED, with information asymmetry preserved", async () => {
	const { runner, calls } = queued([
		STEEL_1,
		{ verdict: "REJECTED", fatal_flaws: [{ claim: "flaw-1", breaks: "goal", why: "evidence" }] },
		{ ...STEEL_1, proposal: "strong-2" },
		{ verdict: "APPROVED" },
	]);
	const revisions: number[][] = [];
	const outcome = await runAdversarialGate({
		goal: "ship it",
		proposal: "original",
		runner,
		revise: async (flaws, iteration) => {
			revisions.push([iteration, flaws.length]);
			return `revised-${iteration}`;
		},
	});
	assert.equal(outcome.kind, "approved");
	// The second steel-man dispatch carries only the named flaws and the revised proposal.
	const secondSteel = calls[2];
	assert.equal(secondSteel.input.proposal, "revised-1");
	assert.deepEqual((secondSteel.input.fatal_flaws as { claim: string }[]).map((f) => f.claim), ["flaw-1"]);
	// The contrarian never sees the original draft or prior history.
	const firstContrarian = calls[1];
	assert.equal(firstContrarian.input.proposal, "strong-1");
	assert.equal(firstContrarian.input.proposal === "original", false);
	assert.equal("fatal_flaws" in firstContrarian.input, false);
	assert.equal("iteration" in firstContrarian.input, false);
	assert.deepEqual(revisions, [[1, 1]]);
});

test("gate: iteration cap settles capped with the best case and flaw list", async () => {
	const flaws = [{ claim: "flaw", breaks: "goal", why: "why" }];
	const { runner } = queued([
		STEEL_1, { verdict: "REJECTED", fatal_flaws: flaws },
		STEEL_1, { verdict: "REJECTED", fatal_flaws: flaws },
		STEEL_1, { verdict: "REJECTED", fatal_flaws: flaws },
	]);
	const outcome = await runAdversarialGate({ goal: "ship it", proposal: "original", runner, iterationCap: 2 });
	assert.equal(outcome.kind, "capped");
	if (outcome.kind !== "capped") return;
	assert.equal(outcome.iterations, 2);
	assert.equal(outcome.bestCase.proposal, "strong-1");
	assert.equal(outcome.flaws[0].claim, "flaw");
});

test("gate: structural flag short-circuits before the contrarian", async () => {
	const { runner, calls } = queued([{ structural_flag: { reason: "goal identity cannot be preserved" } }]);
	const outcome = await runAdversarialGate({ goal: "ship it", proposal: "original", runner });
	assert.equal(outcome.kind, "structural-flag");
	assert.deepEqual(calls.map((c) => c.specialist), ["steelman"]);
});

test("gate: goal drift in the strengthened output is a structural flag", async () => {
	const { runner } = queued([{ ...STEEL_1, goal: "different goal" }]);
	const outcome = await runAdversarialGate({ goal: "ship it", proposal: "original", runner });
	assert.equal(outcome.kind, "structural-flag");
});

test("gate: PROTOCOL_INVALID is retried once, then reported", async () => {
	const { runner } = queued([
		STEEL_1, { verdict: "PROTOCOL_INVALID", protocol_invalid_reason: "contamination" },
		STEEL_1, { verdict: "PROTOCOL_INVALID", protocol_invalid_reason: "contamination" },
	]);
	const invalid: string[] = [];
	const outcome = await runAdversarialGate({
		goal: "ship it",
		proposal: "original",
		runner,
		onProtocolInvalid: (reason) => invalid.push(reason),
	});
	assert.equal(outcome.kind, "protocol-invalid");
	assert.deepEqual(invalid, ["contamination", "contamination"]);
});

test("gate: a schema-invalid steel-man result is a protocol failure, not accepted", async () => {
	const { runner, calls } = queued([{ goal: "ship it" }]);
	const outcome = await runAdversarialGate({ goal: "ship it", proposal: "original", runner });
	assert.equal(outcome.kind, "protocol-invalid");
	assert.equal(calls.length, 1);
});
