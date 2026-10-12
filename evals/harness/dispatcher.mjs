// Dispatcher shim for the eval suite (spec: workflows/test-eval-spec.md §1/A1).
//
// The harness plays the IO for one standalone dispatch: construct a DISPATCH record per
// orchestrator-internal/protocol.md, validate it, invoke the candidate agent, validate the
// RESULT against schemas/results.schema.json, accept `notify` output, and optionally
// re-dispatch once with `retry: fresh` semantics where the scenario demands it.
//
// There is no EO/IO bus here (A1): the shim owns dispatch construction and contract
// validation only. Schema validation is delegated to shared/wire.ts — the single
// executable form of the contracts.

import { checkDispatch, checkResult } from "../../shared/wire.ts";

export class DispatchError extends Error {
	constructor(message, errors = []) {
		super(message);
		this.name = "DispatchError";
		this.errors = errors;
	}
}

export const DEFAULT_BUDGET = { tool_calls: 15, seconds: 300 };

/**
 * Build and schema-validate one DISPATCH record. `specialist` is `test` or `docs`;
 * `requiresTools` names the tool roles the candidate may use.
 */
export function buildDispatch({
	dispatchId,
	specialist,
	taskRef,
	instruction,
	goal,
	constraints = [],
	ledgerRefs = [],
	requiresTools = [],
	budget = DEFAULT_BUDGET,
	input = {},
} = {}) {
	const record = {
		dispatch_id: dispatchId,
		specialist,
		task_ref: taskRef,
		instruction,
		input: { goal, constraints, ledger_refs: ledgerRefs, ...input },
		requires_tools: requiresTools,
		budget,
		reply_expected: "RESULT",
	};
	const check = checkDispatch(record);
	if (!check.ok) throw new DispatchError(`invalid DISPATCH for ${dispatchId}`, check.errors);
	return record;
}

/** Build a dispatch from a scenarios.yaml scenario entry (config is data, shim is code). */
export function buildScenarioDispatch(scenario, { taskRef = `eval-${scenario.id}`, dispatchId = "d-eval" } = {}) {
	const d = scenario.dispatch ?? {};
	return buildDispatch({
		dispatchId,
		specialist: scenario.agent,
		taskRef: scenario.task_ref ?? taskRef,
		instruction: d.instruction ?? scenario.instruction,
		goal: d.goal ?? scenario.goal ?? scenario.id,
		constraints: d.constraints ?? [],
		ledgerRefs: d.ledger_refs ?? [],
		requiresTools: d.requires_tools ?? scenario.requires_tools ?? [],
		budget: d.budget ?? scenario.budget ?? DEFAULT_BUDGET,
		input: d.input,
	});
}

/**
 * Run one dispatch through an agent adapter.
 *
 * `agent(ctx)` returns either a tagged RESULT (`{specialist, result}`) or a bare result
 * payload, which is tagged with the dispatch's specialist before validation. When
 * `retryFresh` is set, a schema-invalid RESULT triggers exactly one re-dispatch with
 * `input.retry: "fresh"` (bounded by `redispatchBudget`).
 */
export async function runDispatch({
	dispatch,
	agent,
	runtime,
	retryFresh = false,
	redispatchBudget = 1,
	clock = () => new Date(),
} = {}) {
	if (!dispatch) throw new DispatchError("runDispatch requires a dispatch");
	if (typeof agent !== "function") throw new DispatchError("runDispatch requires an agent adapter function");
	const maxAttempts = retryFresh ? redispatchBudget + 1 : 1;
	const attempts = [];
	let result;
	let errors = [];
	let tokens = 0;
	const startedAt = clock().getTime();
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const effective =
			attempt === 0
				? dispatch
				: {
						...dispatch,
						dispatch_id: `${dispatch.dispatch_id}-r${attempt}`,
						input: { ...dispatch.input, retry: "fresh" },
					};
		let payload;
		try {
			payload = await agent({ dispatch: effective, runtime, attempt });
		} catch (err) {
			errors = [`agent threw on attempt ${attempt}: ${err.message}`];
			attempts.push({ dispatch: effective, valid: false, errors });
			break;
		}
		if (payload && typeof payload === "object" && "tokens" in payload && payload.result !== undefined) {
			tokens += Number(payload.tokens) || 0;
			payload = { specialist: dispatch.specialist, result: payload.result };
		} else if (payload && typeof payload === "object" && payload.specialist && payload.result !== undefined) {
			// already tagged
		} else {
			payload = { specialist: dispatch.specialist, result: payload };
		}
		const check = checkResult(payload);
		attempts.push({ dispatch: effective, valid: check.ok, errors: check.ok ? [] : check.errors });
		if (check.ok) {
			result = payload.result;
			break;
		}
		errors = check.errors;
	}
	const seconds = (clock().getTime() - startedAt) / 1000;
	return {
		dispatch,
		attempts,
		result,
		valid: result !== undefined,
		errors,
		notifications: runtime ? [...runtime.notifications] : [],
		consumedToolCalls: runtime ? runtime.consumed : 0,
		tokens,
		seconds,
	};
}
