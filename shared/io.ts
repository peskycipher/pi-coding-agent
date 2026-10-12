// IO harness — the reference implementation of workflows/orchestrator-internal
// (design.md lifecycle stages 1–6 mechanics; protocol.md dispatch/RESULT/ledger).
//
// Implemented specialists: scout (research), test (verify-only), docs (docs-drift and
// release-notes). The plan/build-dependent `implement` shape is deliberately still
// unimplemented and fails honestly with recoveryOptions rather than improvising
// (design.md §Execution authority) — tests/io-harness.test.ts pins that invariant.
// The adversarial gate (steel-man/contrarian) is available as `runGate` for EO-side spec
// gates and future IO plan gates; it is not auto-attached to `implement` because that
// pipeline is not built yet.
//
// Scope: intake (ledger idempotency, spec gate) → delegation planning → dispatch loop
// (one outstanding dispatch per specialist) → contract validation (shared/wire.ts)
// → aggregation → COMPLETION/FAILURE events. Specialist execution is behind the
// SpecialistRunner interface (shared/shim.ts): deterministic ScriptedRunner for tests,
// PiRunner for real model runs. Observability stamping (shared/telemetry.ts) is threaded
// through every dispatch and ledger entry.
//
// Wire rules honored here:
//  - the store allocates `seq` (the EO is the persistence tier — protocol §Ledger custody)
//  - every RESULT is validated against the specialist's contract before aggregation
//  - contract violation = specialist failure: one re-formed retry, then stage routing
//  - repeating a TASK with the same task_ref answers from the ledger (protocol §Ordering)

import { checkDispatch, checkResult } from "./wire.ts";
import {
	childSpan,
	Metrics,
	NULL_LOG_SINK,
	rootSpan,
	type LogSink,
	type TraceContext,
} from "./telemetry.ts";
import {
	decideGateAttach,
	runAdversarialGate,
	type FatalFlaw,
	type GateFacts,
	type GateOutcome,
} from "./adversarial.ts";

export type PipelineShape = "research" | "docs-drift" | "release-notes" | "verify-only" | "implement";

export interface TaskInput {
	task_ref: string;
	goal: string;
	/** optional explicit shape; defaults to research (scout) in this harness increment */
	shape?: PipelineShape;
	/** EO design §Session input artifacts: spec mounted at provisioning, SHA recorded */
	spec?: { path: string; sha: string };
	constraints?: string[];
	/** explicit verify target (SHA/branch/path) for the verify-only shape */
	target?: string;
	/** facts the caller knows for mechanical adversarial-gate attachment */
	gate?: GateFacts;
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

/** Every specialist the bus can address (schemas/results.schema.json `dispatch` enum). */
export type Specialist = "scout" | "plan" | "build" | "test" | "docs" | "steelman" | "contrarian";

export interface DispatchRecord {
	dispatch_id: string;
	specialist: Specialist;
	task_ref: string;
	instruction: string;
	input: { goal: string; constraints?: string[]; ledger_refs?: string[]; fatal_flaws?: FatalFlaw[]; [key: string]: unknown };
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
	/** Default runner; `runners[specialist]` overrides it for that specialist. */
	runner: SpecialistRunner;
	/** per-specialist overrides (e.g. a real pi runner per prompt) */
	runners?: Partial<Record<Specialist, SpecialistRunner>>;
	/** per-dispatch budget sent with DISPATCHes; defaults from EO-protocol §Timeouts */
	defaultBudget?: { tool_calls: number; seconds: number };
	now?: () => string;
	/** observability: bounded-label metrics; a fresh registry when omitted */
	metrics?: Metrics;
	/** observability: structured-log sink; records are dropped when omitted */
	logs?: LogSink;
	/** entry point stamped on every log record (defaults to "internal") */
	entryPoint?: string;
}

/** Tool roles per specialist, from each specialist's own workflow.md inventory. */
export const SPECIALIST_TOOLS: Readonly<Record<Specialist, string[]>> = {
	scout: ["glob", "grep", "read"],
	plan: ["read", "glob", "grep"],
	build: ["run-build", "run-check", "read-log", "workspace-read", "env-check"],
	test: ["run-suite", "run-test", "read-log", "workspace-read", "env-check", "git-info"],
	docs: ["run-check", "read-log", "workspace-read", "git-info"],
	steelman: [],
	contrarian: [],
};

const RESEARCH_FAILURE_RECOVERY = ["re-dispatch:scout", "clarify"];
const TEST_FAILURE_RECOVERY = ["re-dispatch:test", "clarify"];
const DOCS_FAILURE_RECOVERY = ["re-dispatch:docs", "clarify"];

type DispatchOutcome =
	| { ok: true; value: unknown; attempts: number }
	| { ok: false; failures: string[]; dispatchId: string | null };

/** Aggregated gate result: the loop outcome plus whether attachment applied. */
export type GateRunResult =
	| ({ attached: true; gate: "adversarial"; attachReason: string } & GateOutcome)
	| { attached: false; gate: "adversarial"; attachReason: string };

export interface GateRunInput {
	goal: string;
	constraints?: string[];
	proposal: string;
	/** when provided, the mechanical attach criteria decide; when omitted, the gate attaches */
	facts?: GateFacts;
	iterationCap?: number;
}

export class IoHarness {
	private dispatchCounter = 0;
	private readonly opts: HarnessOptions;
	readonly metrics: Metrics;
	private readonly logs: LogSink;
	private readonly entryPoint: string;

	constructor(opts: HarnessOptions) {
		this.opts = opts;
		this.metrics = opts.metrics ?? new Metrics();
		this.logs = opts.logs ?? NULL_LOG_SINK;
		this.entryPoint = opts.entryPoint ?? "internal";
	}

	/** Run one task to settlement. Returns the terminal event payload. */
	async runTask(task: TaskInput): Promise<Extract<HarnessEvent, { type: "completion" | "failure" }>["payload"]> {
		const { ledger, emit, now = () => new Date().toISOString() } = this.opts;
		const trace = rootSpan(task.task_ref);
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
			// implement path; for other shapes a mounted spec is referenced not verified.
			// The SHA-match re-verify happens in the EO shim at provisioning (protocol
			// §Session input artifacts); recorded here as an ASSUMPTION ledger entry.
			ledger.append({ ts: now(), kind: "ASSUMPTION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `spec mounted at ${task.spec.path} sha=${task.spec.sha} (verify-only use; checklist applies to implement pipelines)`, status: "recorded" });
		}

		ledger.append({ ts: now(), kind: "TASK", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: task.goal, status: "intake" });
		this.logs.log({ ts: now(), event: "task_received", trace_id: trace.trace_id, entry_point: this.entryPoint, task_ref: task.task_ref, shape: task.shape ?? "research" });
		emit({ type: "status", payload: { stage: "intake", lastEvent: `task ${task.task_ref} accepted` } });

		// Stage 2 — delegation planning
		const shape: PipelineShape = task.shape ?? "research";
		switch (shape) {
			case "research":
				return this.#runResearch(task, trace);
			case "verify-only":
				return this.#runVerifyOnly(task, trace);
			case "docs-drift":
				return this.#runDocs(task, trace, "docs-drift");
			case "release-notes":
				return this.#runDocs(task, trace, "release-notes");
			case "implement":
			default:
				return this.#unimplemented(task, trace, shape);
		}
	}

	/**
	 * Adversarial gate for a proposal (adversarial/design.md). EO-side spec gate and the
	 * future IO plan gate share this method. Every iteration is ledgered as a DECISION
	 * entry and counted in `agent_loop_iterations_total`; a skip is ledgered and counted
	 * in `agent_gate_skipped_total` so silent non-attachment cannot happen.
	 */
	async runGate(task: TaskInput, run: GateRunInput): Promise<GateRunResult> {
		const { ledger, now = () => new Date().toISOString() } = this.opts;
		const trace = rootSpan(task.task_ref);
		const attach = run.facts === undefined ? { attach: true, reason: "explicit gate invocation" } : decideGateAttach(run.facts);
		if (!attach.attach) {
			ledger.append({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `adversarial gate skipped: ${attach.reason}`, status: "gate_skipped" });
			this.logs.log({ ts: now(), event: "gate_skipped", trace_id: trace.trace_id, entry_point: this.entryPoint, gate: "adversarial", reason: attach.reason });
			this.metrics.increment("agent_gate_skipped_total", { gate: "adversarial" });
			return { attached: false, gate: "adversarial", attachReason: attach.reason };
		}
		this.logs.log({ ts: now(), event: "gate_attached", trace_id: trace.trace_id, entry_point: this.entryPoint, gate: "adversarial", reason: attach.reason });

		const outcome = await runAdversarialGate({
			goal: run.goal,
			constraints: run.constraints,
			proposal: run.proposal,
			iterationCap: run.iterationCap,
			runner: async (specialist, input) => {
				const result = await this.#dispatchSpecialist({
					specialist,
					task,
					shape: "gate",
					instruction: specialist === "steelman"
						? "Strengthen the proposal; state premises explicitly per the steel-man RESULT contract"
						: "Attack the steel-man's best case; return APPROVED or REJECTED with fatal flaws only",
					input,
					span: childSpan(trace),
				});
				// Contract failure inside dispatch means no RESULT to hand the gate; an empty
				// payload fails the gate's own wire check and yields PROTOCOL_INVALID honestly.
				return result.ok ? result.value : {};
			},
			onIteration: (iteration, verdict, flaws) => {
				ledger.append({ ts: now(), kind: "DECISION", ref: `gate-iter-${iteration}`, trace_id: task.task_ref, span_id: trace.span_id, summary: `adversarial iteration ${iteration}: ${verdict}${flaws.length ? ` — ${flaws.map((f) => f.claim).join("; ")}` : ""}`, status: verdict === "APPROVED" ? "gate-approved" : verdict === "REJECTED" ? "gate-rejected" : "gate-protocol-invalid" });
			},
			onStructuralFlag: (flag) => {
				ledger.append({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `steel-man structural flag: ${flag.reason}`, status: "gate-structural-flag" });
			},
		});
		this.metrics.increment("agent_loop_iterations_total", { agent: "io", gate: "adversarial" }, outcome.iterations);
		if (outcome.kind === "capped") {
			this.logs.log({ ts: now(), event: "escalation_raised", trace_id: trace.trace_id, entry_point: this.entryPoint, gate: "adversarial", reason: "iteration cap hit", flaws: outcome.flaws.map((f) => f.claim) });
		}
		return { attached: true, gate: "adversarial", attachReason: attach.reason, ...outcome };
	}

	// --- shapes -------------------------------------------------------------

	async #runResearch(task: TaskInput, trace: TraceContext): Promise<Extract<HarnessEvent, { type: "completion" | "failure" }>["payload"]> {
		const result = await this.#dispatchSpecialist({
			specialist: "scout",
			task,
			shape: "research",
			instruction: "Research the objective; return findings per the scout RESULT contract",
			input: { goal: task.goal, constraints: task.constraints },
			span: childSpan(trace),
		});
		if (!result.ok) return this.#specialistFailure(task, trace, "scout", result, RESEARCH_FAILURE_RECOVERY);
		const payload = { summary: `goal: ${task.goal} — scout findings accepted (contract-valid, attempt ${result.attempts})`, verdictAttenuations: [], artifactRefs: [], ledgerRef: `task:${task.task_ref}` };
		this.#settle(task, trace, payload);
		return payload;
	}

	async #runVerifyOnly(task: TaskInput, trace: TraceContext): Promise<Extract<HarnessEvent, { type: "completion" | "failure" }>["payload"]> {
		const result = await this.#dispatchSpecialist({
			specialist: "test",
			task,
			shape: "verify-only",
			instruction: "Run the selected suite and classify each test per the test RESULT contract",
			input: { goal: task.goal, constraints: task.constraints, ...(task.target ? { target: task.target } : {}) },
			span: childSpan(trace),
		});
		if (!result.ok) return this.#specialistFailure(task, trace, "test", result, TEST_FAILURE_RECOVERY);
		const payload = { summary: `goal: ${task.goal} — test verdicts accepted (contract-valid, attempt ${result.attempts})`, verdictAttenuations: [], artifactRefs: [], ledgerRef: `task:${task.task_ref}` };
		this.#settle(task, trace, payload);
		return payload;
	}

	async #runDocs(task: TaskInput, trace: TraceContext, kind: "docs-drift" | "release-notes"): Promise<Extract<HarnessEvent, { type: "completion" | "failure" }>["payload"]> {
		const result = await this.#dispatchSpecialist({
			specialist: "docs",
			task,
			shape: kind,
			instruction: kind === "release-notes"
				? "Draft release notes tied to ledger entries only; return doc_updates, claims_index_delta, release_notes, verdict per the docs RESULT contract"
				: "Verify doc claims against the changed surface; return doc_updates, claims_index_delta, verdict per the docs RESULT contract",
			input: { goal: task.goal, constraints: task.constraints },
			span: childSpan(trace),
		});
		if (!result.ok) return this.#specialistFailure(task, trace, "docs", result, DOCS_FAILURE_RECOVERY);
		this.#emitDocsSignals(result.value, kind, trace);
		const payload = { summary: `goal: ${task.goal} — docs ${kind} result accepted (contract-valid, attempt ${result.attempts})`, verdictAttenuations: [], artifactRefs: [], ledgerRef: `task:${task.task_ref}` };
		this.#settle(task, trace, payload);
		return payload;
	}

	async #unimplemented(task: TaskInput, trace: TraceContext, shape: string): Promise<Extract<HarnessEvent, { type: "failure" }>["payload"]> {
		const { ledger, emit, now = () => new Date().toISOString() } = this.opts;
		const payload = {
			failingStep: "planning",
			classification: "pipeline-unimplemented",
			evidence: [`shape "${shape}" requires specialists not implemented in this harness increment (roster implemented: scout, test, docs; adversarial gate available via runGate)`],
			attempts: 0,
			recoveryOptions: ["revise-task: research"],
		};
		ledger.append({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `pipeline shape ${shape} unimplemented in this increment`, status: "settled-failure" });
		this.metrics.increment("agent_task_total", { agent: "io", outcome: "failure" });
		emit({ type: "failure", payload });
		return payload;
	}

	// --- dispatch + aggregation helpers ------------------------------------

	async #dispatchSpecialist(params: {
		specialist: Specialist;
		task: TaskInput;
		shape: PipelineShape | "gate";
		instruction: string;
		input: DispatchRecord["input"];
		span: TraceContext;
		attempts?: number;
	}): Promise<DispatchOutcome> {
		const { ledger, emit, now = () => new Date().toISOString() } = this.opts;
		const attempts = params.attempts ?? 2; // 1 attempt + 1 re-formed retry (design Stage 5)
		const failures: string[] = [];
		let lastDispatchId: string | null = null;

		for (let attempt = 1; attempt <= attempts; attempt++) {
			const id = `d-${++this.dispatchCounter}`;
			lastDispatchId = id;
			const dispatch: DispatchRecord = {
				dispatch_id: id,
				specialist: params.specialist,
				task_ref: params.task.task_ref,
				instruction: attempt === 1
					? params.instruction
					: `Re-output ONLY the ${params.specialist} RESULT contract fields (schema-valid) for the same objective`,
				input: params.input,
				requires_tools: SPECIALIST_TOOLS[params.specialist],
				budget: this.opts.defaultBudget ?? { tool_calls: 15, seconds: 300 },
				reply_expected: "RESULT",
			};
			const wireCheck = checkDispatch(dispatch as unknown as Record<string, unknown>);
			if (!wireCheck.ok) failures.push(`dispatch wire-invalid: ${wireCheck.errors.join("; ")}`);
			ledger.append({ ts: now(), kind: "DISPATCH", ref: id, trace_id: params.task.task_ref, span_id: params.span.span_id, summary: dispatch.instruction, status: attempt === 1 ? "sent" : "resent-reformed" });
			this.logs.log({ ts: now(), event: "dispatch_sent", trace_id: params.span.trace_id, entry_point: this.entryPoint, dispatch_id: id, specialist: params.specialist, shape: params.shape });
			emit({ type: "status", payload: { stage: `dispatch:${id}`, lastEvent: `${params.specialist} dispatched (attempt ${attempt})` } });

			const runner = this.opts.runners?.[params.specialist] ?? this.opts.runner;
			const startedAt = Date.now();
			let raw: unknown;
			try {
				raw = await runner.run(dispatch);
			} catch (err) {
				this.metrics.observe("agent_dispatch_duration_seconds", { agent: params.specialist, stage: params.shape }, (Date.now() - startedAt) / 1000);
				failures.push(`attempt ${attempt}: runner error: ${(err as Error).message}`);
				continue;
			}
			this.metrics.observe("agent_dispatch_duration_seconds", { agent: params.specialist, stage: params.shape }, (Date.now() - startedAt) / 1000);
			const check = checkResult({ specialist: params.specialist, result: raw });
			if (!check.ok) {
				this.metrics.increment("agent_contract_violations_total", { specialist: params.specialist });
				this.logs.log({ ts: now(), event: "contract_violation", trace_id: params.span.trace_id, entry_point: this.entryPoint, dispatch_id: id, specialist: params.specialist, errors: check.errors.slice(0, 3) });
				failures.push(`attempt ${attempt}: contract violation — ${check.errors.slice(0, 3).join("; ")}`);
				continue;
			}
			ledger.append({ ts: now(), kind: "RESULT", ref: id, trace_id: params.task.task_ref, span_id: params.span.span_id, summary: `contract-valid ${params.specialist} RESULT (attempt ${attempt})`, status: "accepted" });
			this.logs.log({ ts: now(), event: "result_received", trace_id: params.span.trace_id, entry_point: this.entryPoint, dispatch_id: id, specialist: params.specialist });
			return { ok: true, value: raw, attempts: attempt };
		}
		return { ok: false, failures, dispatchId: lastDispatchId };
	}

	#specialistFailure(task: TaskInput, trace: TraceContext, specialist: Specialist, result: Extract<DispatchOutcome, { ok: false }>, recovery: string[]): Extract<HarnessEvent, { type: "failure" }>["payload"] {
		const { ledger, emit, now = () => new Date().toISOString() } = this.opts;
		const payload = {
			failingStep: result.dispatchId ? `dispatch:${result.dispatchId}` : "planning",
			classification: "specialist-failed",
			evidence: result.failures,
			attempts: result.failures.length,
			recoveryOptions: recovery,
		};
		ledger.append({ ts: now(), kind: "DECISION", ref: result.dispatchId ?? task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `${specialist} failed after ${result.failures.length} attempts: ${result.failures[0] ?? "no attempts"}`, status: "settled-failure" });
		this.metrics.increment("agent_retry_total", { agent: specialist, lane: task.shape ?? "research" }, Math.max(0, result.failures.length - 1));
		this.metrics.increment("agent_task_total", { agent: "io", outcome: "failure" });
		emit({ type: "failure", payload });
		return payload;
	}

	#settle(task: TaskInput, trace: TraceContext, payload: Extract<HarnessEvent, { type: "completion" }>["payload"]): void {
		const { ledger, emit, now = () => new Date().toISOString() } = this.opts;
		ledger.append({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: payload.summary, status: "settled-completion" });
		this.metrics.increment("agent_task_total", { agent: "io", outcome: "completion" });
		emit({ type: "completion", payload });
	}

	/** Docs telemetry: one stale-claim count per risk class, plus the drift log line. */
	#emitDocsSignals(value: unknown, kind: "docs-drift" | "release-notes", trace: TraceContext): void {
		if (kind !== "docs-drift") return;
		const verdict = (value as { verdict?: { stale_sections?: unknown[] } }).verdict;
		const stale = Array.isArray(verdict?.stale_sections) ? verdict!.stale_sections! : [];
		const now = this.opts.now ?? (() => new Date().toISOString());
		for (const section of stale) {
			const rawRisk = typeof section === "object" && section !== null ? String((section as { risk?: unknown }).risk ?? "unknown") : "unknown";
			const risk = rawRisk === "wrong-instruction" || rawRisk === "outdated-reference" || rawRisk === "cosmetic" ? rawRisk : "unknown";
			this.metrics.increment("agent_docs_stale_claims_total", { risk_class: risk });
			this.logs.log({ ts: now(), event: "docs_drift_detected", trace_id: trace.trace_id, entry_point: this.entryPoint, risk_class: risk });
		}
	}
}
