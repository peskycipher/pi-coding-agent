// IO harness — the reference implementation of workflows/orchestrator-internal
// (design.md lifecycle stages 1–6 mechanics; protocol.md dispatch/RESULT/ledger).
//
// Scope (increment 1): `research` pipelines via the scout specialist, end-to-end:
// intake (ledger idempotency, spec gate) → delegation planning → dispatch loop
// (one outstanding dispatch per specialist) → contract validation (shared/wire.ts)
// → aggregation → COMPLETION/FAILURE events. Specialist execution is behind the
// SpecialistRunner interface (shared/shim.ts): deterministic ScriptedRunner for tests,
// PiRunner for real model runs. Unimplemented shapes fail honestly with recoveryOptions
// rather than improvising (design.md §Execution authority).
//
// Wire rules honored here:
//  - the store allocates `seq` (the EO is the persistence tier — protocol §Ledger custody)
//  - every RESULT is validated against the specialist's contract before aggregation
//  - contract violation = specialist failure: one re-formed retry, then stage routing
//  - repeating a TASK with the same task_ref answers from the ledger (protocol §Ordering)

import { checkDispatch, checkResult } from "./wire.ts";

export type PipelineShape = "research" | "docs-drift" | "release-notes" | "verify-only" | "implement";

export interface TaskInput {
	task_ref: string;
	goal: string;
	/** optional explicit shape; defaults to research (scout) in this increment */
	shape?: PipelineShape;
	/** EO design §Session input artifacts: spec mounted at provisioning, SHA recorded */
	spec?: { path: string; sha: string };
	constraints?: string[];
}

export type LedgerKind = "TASK" | "ASSUMPTION" | "DISPATCH" | "RESULT" | "DECISION" | "REVISION" | "ARTIFACT_EXPORT";

export interface LedgerEntry {
	seq: number | null;
	ts: string;
	kind: LedgerKind;
	ref: string;
	trace_id: string;
	span_id: string | null;
	summary: string;
	status: string;
}

/** Ledger store: the EO persists; the IO writes with empty `seq`, store stamps it.
 * `entries()` lets the IO read back the ledger it was handed (intake idempotency). */
export interface LedgerStore {
	append(entry: Omit<LedgerEntry, "seq">): LedgerEntry;
	entries(): readonly LedgerEntry[];
}

export class InMemoryLedger implements LedgerStore {
	private nextSeq = 1;
	private records: LedgerEntry[] = [];
	append(entry: Omit<LedgerEntry, "seq">): LedgerEntry {
		const stamped: LedgerEntry = { ...entry, seq: this.nextSeq++ };
		this.records.push(stamped);
		return stamped;
	}
	entries(): readonly LedgerEntry[] {
		return this.records;
	}
}

export type HarnessEvent =
	| { type: "status"; payload: { stage: string; lastEvent: string } }
	| { type: "clarification"; payload: { questions: { id: string; text: string; defaultAssumption: string }[]; resumePoint: string } }
	| { type: "completion"; payload: { summary: string; verdictAttenuations: string[]; artifactRefs: string[]; ledgerRef: string } }
	| { type: "failure"; payload: { failingStep: string; classification: string; evidence: string[]; attempts: number; recoveryOptions: string[] } };

export interface DispatchRecord {
	dispatch_id: string;
	specialist: "scout" | "plan" | "build" | "test" | "docs";
	task_ref: string;
	instruction: string;
	input: { goal: string; constraints?: string[]; ledger_refs?: string[]; fatal_flaws?: string[] };
	requires_tools: string[];
	budget: { tool_calls: number; seconds: number };
	reply_expected: "RESULT";
}

export interface SpecialistRunner {
	/** Execute the dispatch and return the RESULT payload object (pre-validation). */
	run(dispatch: DispatchRecord): Promise<unknown>;
}

export interface HarnessOptions {
	ledger: LedgerStore;
	emit: (e: HarnessEvent) => void;
	runner: SpecialistRunner;
	/** per-dispatch budget sent with DISPATCHes; defaults from EO-protocol §Timeouts */
	defaultBudget?: { tool_calls: number; seconds: number };
	now?: () => string;
}

export class IoHarness {
	private dispatchCounter = 0;
	private readonly opts: HarnessOptions;
	constructor(opts: HarnessOptions) {
		this.opts = opts;
	}

	/** Run one task to settlement. Returns the terminal event payload. */
	async runTask(task: TaskInput): Promise<Extract<HarnessEvent, { type: "completion" | "failure" }>["payload"]> {
		const { ledger, emit, runner, now = () => new Date().toISOString() } = this.opts;
		// Stage 1 — intake: idempotent re-ask first (protocol §Ordering)
		const priorSettle = ledger
			.entries()
			.filter((e) => e.trace_id === task.task_ref && e.kind === "DECISION")
			.find((e) => e.status === "settled-completion" || e.status === "settled-failure");
		if (priorSettle) {
			// answer from the ledger, do not re-run
			if (priorSettle.status === "settled-completion") {
				const payload = { summary: priorSettle.summary, verdictAttenuations: [], artifactRefs: [], ledgerRef: `task:${task.task_ref}` };
				emit({ type: "completion", payload });
				return payload;
			}
			const payload = { failingStep: "intake", classification: "previously-failed", evidence: [priorSettle.summary], attempts: 0, recoveryOptions: ["resume"] };
			emit({ type: "failure", payload });
			return payload;
		}

		// spec gate (IO design §Stage 1 Spec intake) — only when a spec is attached
		if (task.spec?.sha) {
			// increment 1: the shared-checklist verification is IO-pipeline work for the
			// implement path; for research tasks a mounted spec is referenced not verified.
			// The SHA-match re-verify happens in the EO shim at provisioning (protocol
			// §Session input artifacts); recorded here as an ASSUMPTION ledger entry.
			ledger.append({ ts: now(), kind: "ASSUMPTION", ref: task.task_ref, trace_id: task.task_ref, span_id: null, summary: `spec mounted at ${task.spec.path} sha=${task.spec.sha} (verify-only use; checklist applies to implement pipelines)`, status: "recorded" });
		}

		ledger.append({ ts: now(), kind: "TASK", ref: task.task_ref, trace_id: task.task_ref, span_id: null, summary: task.goal, status: "intake" });
		emit({ type: "status", payload: { stage: "intake", lastEvent: `task ${task.task_ref} accepted` } });

		// Stage 2 — delegation planning
		const shape: PipelineShape = task.shape ?? "research";
		if (shape !== "research") {
			const payload = { failingStep: "planning", classification: "pipeline-unimplemented", evidence: [`shape "${shape}" requires specialists not implemented in this harness increment (roster implemented: scout)`], attempts: 0, recoveryOptions: ["revise-task: research"] };
			ledger.append({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: null, summary: `pipeline shape ${shape} unimplemented in increment 1`, status: "settled-failure" });
			emit({ type: "failure", payload });
			return payload;
		}

		// Stage 3/4 — dispatch loop: scout, one outstanding, contract-validated
		const attempts = 2; // 1 attempt + 1 re-formed retry (design Stage 5)
		const failures: string[] = [];
		let dispatch: DispatchRecord | null = null;
		let validated: unknown = null;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const id = `d-${++this.dispatchCounter}`;
			dispatch = {
				dispatch_id: id,
				specialist: "scout",
				task_ref: task.task_ref,
				instruction: attempt === 1
					? "Research the objective; return findings per the scout RESULT contract"
					: "Re-output ONLY the scout RESULT contract fields (schema-valid) for the same objective",
				input: { goal: task.goal, constraints: task.constraints },
				requires_tools: ["glob", "grep", "read"],
				budget: this.opts.defaultBudget ?? { tool_calls: 15, seconds: 300 },
				reply_expected: "RESULT",
			};
			const wireCheck = checkDispatch(dispatch as unknown as Record<string, unknown>);
			if (!wireCheck.ok) failures.push(`dispatch wire-invalid: ${wireCheck.errors.join("; ")}`);
			ledger.append({ ts: now(), kind: "DISPATCH", ref: id, trace_id: task.task_ref, span_id: null, summary: dispatch.instruction, status: attempt === 1 ? "sent" : "resent-reformed" });
			emit({ type: "status", payload: { stage: `dispatch:${id}`, lastEvent: `scout dispatched (attempt ${attempt})` } });

			let raw: unknown;
			try {
				raw = await runner.run(dispatch);
			} catch (err) {
				failures.push(`attempt ${attempt}: runner error: ${(err as Error).message}`);
				continue;
			}
			const check = checkResult({ specialist: dispatch.specialist, result: raw });
			if (!check.ok) {
				failures.push(`attempt ${attempt}: contract violation — ${check.errors.slice(0, 3).join("; ")}`);
				continue;
			}
			validated = raw;
			ledger.append({ ts: now(), kind: "RESULT", ref: id, trace_id: task.task_ref, span_id: null, summary: `contract-valid scout RESULT (attempt ${attempt})`, status: "accepted" });
			break;
		}

		if (validated === null || !dispatch) {
			// Stage 5 — stage routing: research shape cannot degrade without scout findings
			const payload = { failingStep: dispatch ? `dispatch:${dispatch.dispatch_id}` : "planning", classification: "specialist-failed", evidence: failures, attempts: failures.length, recoveryOptions: ["re-dispatch:scout", "clarify"] };
			ledger.append({ ts: now(), kind: "DECISION", ref: dispatch?.dispatch_id ?? task.task_ref, trace_id: task.task_ref, span_id: null, summary: `scout failed after ${failures.length} attempts: ${failures[0] ?? "no attempts"}`, status: "settled-failure" });
			emit({ type: "failure", payload });
			return payload;
		}
		const payload = { summary: `goal: ${task.goal} — scout findings accepted (contract-valid, attempt ${failures.length + 1})`, verdictAttenuations: [], artifactRefs: [], ledgerRef: `task:${task.task_ref}` };
		ledger.append({ ts: now(), kind: "DECISION", ref: dispatch.dispatch_id, trace_id: task.task_ref, span_id: null, summary: payload.summary, status: "settled-completion" });
		emit({ type: "completion", payload });
		return payload;
	}
}