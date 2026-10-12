// Adversarial review gate — the executable form of workflows/adversarial/design.md.
//
// A steel-man strengthens a proposal; a contrarian attacks only that strengthened output
// and returns a strictly binary verdict. On REJECTED the proposal's owner (the `revise`
// callback, e.g. the plan specialist) addresses the named fatal flaws and the loop runs
// again under a hard iteration cap. Information asymmetry is intentional: the contrarian
// dispatch carries the steel-man RESULT only — never the original draft, never prior
// history. This module owns the loop and the contract checks; callers own dispatch,
// ledger writes, and metrics (see `IoHarness`).
//
// Contract enforcement uses the same single source of truth as every other RESULT path:
// workflows/schemas/results.schema.json via shared/wire.ts. Schema failure is a specialist
// failure and stops the loop honestly rather than feeding garbage onward.

import { checkResult } from "./wire.ts";

/** Facts the IO/EO already knows that decide mechanical gate attachment (design.md). */
export interface GateFacts {
	/** Spec boundaries include publish-shaped or irreversible actions. */
	publishShaped?: boolean;
	/** Route mode is parallel — interface contracts are the fragile surface. */
	parallelRoute?: boolean;
	/** Number of capability-map modules; the design attaches at >= 3. */
	capabilityMapModules?: number;
	/** Days since a prior iteration of this proposal was rejected; attach at <= 7. */
	daysSincePriorRejection?: number;
}

export interface GateAttachDecision {
	attach: boolean;
	/** Non-empty and ledgered whether attached or skipped — silent non-attachment is drift. */
	reason: string;
}

/** The attach criteria are applied mechanically; a skip is visible, never silent. */
export function decideGateAttach(facts: GateFacts): GateAttachDecision {
	if (facts.publishShaped) return { attach: true, reason: "publish-shaped or irreversible boundary" };
	if (facts.parallelRoute) return { attach: true, reason: "parallel route: interface contract surface" };
	if ((facts.capabilityMapModules ?? 0) >= 3) return { attach: true, reason: "capability map has >= 3 modules" };
	if (facts.daysSincePriorRejection !== undefined && facts.daysSincePriorRejection <= 7)
		return { attach: true, reason: "same proposal was rejected in the last 7 days" };
	return { attach: false, reason: "no attach criterion met (default: skip and ledger)" };
}

export interface FatalFlaw {
	claim: string;
	breaks: string;
	why: string;
}

export interface SteelManResult {
	goal: string;
	proposal: string;
	premises: { claim: string; basis: string }[];
	preempted_objections: unknown[];
	open_problems: unknown[];
}

export interface StructuralFlag {
	reason: string;
}

export interface ContrarianResult {
	verdict: "APPROVED" | "REJECTED" | "PROTOCOL_INVALID";
	fatal_flaws?: FatalFlaw[];
	protocol_invalid_reason?: "naive-draft" | "contamination";
}

/** The dispatch seam: the IO turns each call into a DISPATCH + ledger entry itself. */
export type GateRunner = (
	specialist: "steelman" | "contrarian",
	/** Contrarian input carries ONLY the steel-man RESULT (information asymmetry). */
	input: { goal: string; constraints?: string[]; proposal: string; fatal_flaws?: FatalFlaw[]; steel_man?: SteelManResult },
) => Promise<unknown>;

export interface AdversarialGateOptions {
	goal: string;
	constraints?: string[];
	/** The proposal's initial text (from plan / REPLAN / spec). */
	proposal: string;
	runner: GateRunner;
	/** Default 3; the gate cannot outlive the plan's escalation rules. */
	iterationCap?: number;
	/** Re-dispatch one extra time on PROTOCOL_INVALID before failing (default 1). */
	protocolInvalidRetries?: number;
	/**
	 * Revision owner seam (design: the plan specialist on plans). Returns the revised
	 * proposal text. When omitted, the flaw list rides the next steel-man dispatch and the
	 * steel-man repairs only the named flaws (its own edge case).
	 */
	revise?: (flaws: FatalFlaw[], iteration: number) => Promise<string>;
	onIteration?: (iteration: number, verdict: ContrarianResult["verdict"], flaws: FatalFlaw[]) => void;
	onStructuralFlag?: (flag: StructuralFlag, iteration: number) => void;
	onProtocolInvalid?: (reason: string, iteration: number) => void;
}

export type GateOutcome =
	| { kind: "approved"; iterations: number; premises: SteelManResult["premises"]; flaws: FatalFlaw[] }
	| { kind: "capped"; iterations: number; bestCase: SteelManResult; flaws: FatalFlaw[] }
	| { kind: "structural-flag"; iterations: number; flag: StructuralFlag }
	| { kind: "protocol-invalid"; iterations: number; reason: string };

function isStructuralFlag(v: unknown): v is StructuralFlag {
	return typeof v === "object" && v !== null && "structural_flag" in (v as Record<string, unknown>);
}

/** Loop protocol: strengthen -> attack -> revise, bounded by the iteration cap. */
export async function runAdversarialGate(opts: AdversarialGateOptions): Promise<GateOutcome> {
	const cap = Math.max(1, opts.iterationCap ?? 3);
	const invalidRetries = opts.protocolInvalidRetries ?? 1;
	let proposal = opts.proposal;
	let flaws: FatalFlaw[] = [];
	let invalidUsed = 0;
	let bestCase: SteelManResult | null = null;
	let iteration = 0;

	while (iteration < cap) {
		iteration += 1;

		const steelRaw = await opts.runner("steelman", {
			goal: opts.goal,
			constraints: opts.constraints,
			proposal,
			...(flaws.length > 0 ? { fatal_flaws: flaws } : {}),
		});
		const steelCheck = checkResult({ specialist: "steelman", result: steelRaw });
		if (!steelCheck.ok) {
			return { kind: "protocol-invalid", iterations: iteration, reason: `steelman contract violation: ${steelCheck.errors[0] ?? "schema failure"}` };
		}
		if (isStructuralFlag(steelRaw)) {
			opts.onStructuralFlag?.(steelRaw, iteration);
			return { kind: "structural-flag", iterations: iteration, flag: steelRaw };
		}
		const steel = steelRaw as SteelManResult;
		// Trade-off 2 (anchoring cascade): validate the strengthened version still targets the goal.
		if (steel.goal !== opts.goal) {
			const flag: StructuralFlag = { reason: `strengthened proposal changed the goal ("${steel.goal}" != "${opts.goal}")` };
			opts.onStructuralFlag?.(flag, iteration);
			return { kind: "structural-flag", iterations: iteration, flag };
		}
		bestCase = steel;

		// Information asymmetry: hand the contrarian the steel-man RESULT only.
		const contraRaw = await opts.runner("contrarian", { goal: opts.goal, constraints: opts.constraints, proposal: steel.proposal, steel_man: steel });
		const contraCheck = checkResult({ specialist: "contrarian", result: contraRaw });
		if (!contraCheck.ok) {
			return { kind: "protocol-invalid", iterations: iteration, reason: `contrarian contract violation: ${contraCheck.errors[0] ?? "schema failure"}` };
		}
		const contra = contraRaw as ContrarianResult;
		opts.onIteration?.(iteration, contra.verdict, contra.fatal_flaws ?? []);

		if (contra.verdict === "APPROVED") {
			return { kind: "approved", iterations: iteration, premises: steel.premises, flaws };
		}
		if (contra.verdict === "PROTOCOL_INVALID") {
			invalidUsed += 1;
			const reason = contra.protocol_invalid_reason ?? "unspecified";
			opts.onProtocolInvalid?.(reason, iteration);
			if (invalidUsed > invalidRetries) return { kind: "protocol-invalid", iterations: iteration, reason };
			continue;
		}
		// REJECTED: the revision owner applies the named flaws; nothing else is rewritten.
		flaws = contra.fatal_flaws ?? [];
		if (iteration >= cap) break;
		if (opts.revise) proposal = await opts.revise(flaws, iteration);
	}
	return { kind: "capped", iterations: iteration, bestCase: bestCase as SteelManResult, flaws };
}
