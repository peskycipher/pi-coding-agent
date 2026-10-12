// IO harness — the reference implementation of workflows/orchestrator-internal
// (design.md lifecycle stages 1–6 mechanics; protocol.md dispatch/RESULT/ledger).
//
// Implemented shapes: research (scout), verify-only (test), docs-drift and release-notes
// (docs), and implement — scout → plan → adversarial gate → build → test (design.md Stage 2
// canonical shape; adversarial/design.md §Where it plugs into the suite). The adversarial
// gate (steel-man/contrarian) is attached between plan and build via `runGate`; on REJECTED
// the plan specialist is re-dispatched with the fatal flaws as its revision owner. A truly
// unknown shape still fails honestly with recoveryOptions rather than improvising.
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

/** One tool-role's observed use within a dispatch (args digests stay in the trace, not here). */
export interface ToolCallUse {
	role: string;
	/** Calls with this role; defaults to 1 when the runner reports a role without a count. */
	count?: number;
}

/** Human decision returned by the optional `[approval]` stage (design.md Stage 2). */
export interface ApprovalOutcome {
	granted: boolean;
	/** Seconds the APPROVAL_REQUEST waited for the developer; observed in `approval_wait_seconds`. */
	waitSeconds: number;
	/** What the grant covers; rides the log only, never a metric label. */
	scope?: string;
}

/** The IO's `[approval]` seam: the developer answers an APPROVAL_REQUEST before a build. */
export type ApprovalGate = (context: { task: TaskInput; goal: string; proposal: string }) => Promise<ApprovalOutcome>;

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
	/**
	 * Optional harness usage record (pi/Langfuse token accounting): per specialist call,
	 * returns prompt/completion tokens that feed `agent_tokens_total`. Absent in tests that
	 * do not model cost.
	 */
	usage?: (dispatch: DispatchRecord, result: unknown) => { prompt: number; completion: number } | undefined;
	/**
	 * Optional tool-call record: per dispatch, the tool roles the specialist actually invoked
	 * (pi/Langfuse tool spans, the eval harness's TraceRecorder). Feeds `agent_tool_calls_total`
	 * and, when the count exceeds the DISPATCH budget, `agent_budget_overrun_total`.
	 */
	toolCalls?: (dispatch: DispatchRecord, result: unknown) => readonly ToolCallUse[] | undefined;
	/** Optional developer approval gate for the implement pipeline's `[approval]` stage. */
	approval?: ApprovalGate;
	/** Duration clock (ms) for heartbeat/budget signals; defaults to `Date.now`. */
	nowMs?: () => number;
	/** STATUS heartbeat interval while a dispatch is outstanding (EO-protocol §Heartbeat). */
	heartbeatIntervalMs?: number;
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
const PLAN_FAILURE_RECOVERY = ["re-dispatch:plan", "clarify"];
const BUILD_FAILURE_RECOVERY = ["re-dispatch:build", "clarify"];
const TEST_FAILURE_RECOVERY = ["re-dispatch:test", "clarify"];
const DOCS_FAILURE_RECOVERY = ["re-dispatch:docs", "clarify"];
const GATE_FAILURE_RECOVERY = ["revise-plan", "clarify"];
const GATE_PROTOCOL_RECOVERY = ["re-dispatch:gate", "clarify"];

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
	/**
	 * Revision owner seam (adversarial/design.md §Loop ownership): on REJECTED, re-dispatch
	 * the proposal's owner (the plan specialist on plans) and return the revised proposal
	 * text. When omitted the steel-man repairs the named flaws on the next iteration.
	 */
	revise?: (flaws: FatalFlaw[], iteration: number) => Promise<string>;
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

	/** Duration clock, separate from the ISO `now` timestamp seam so tests can drive both. */
	#nowMs(): number {
		return this.opts.nowMs?.() ?? Date.now();
	}

	/** Append to the ledger AND emit `ledger_appended` (the `kind` rides the log value). */
	#appendLedger(entry: Omit<LedgerEntry, "seq">): LedgerEntry {
		const stamped = this.opts.ledger.append(entry);
		this.logs.log({
			ts: entry.ts,
			event: "ledger_appended",
			trace_id: entry.trace_id,
			entry_point: this.entryPoint,
			kind: entry.kind,
			ref: entry.ref,
			status: entry.status,
		});
		return stamped;
	}

	/**
	 * Record a NAK frame seen by the IO. `side` names the protocol side whose frame was
	 * malformed ("external" = EO → IO, "internal" = IO → specialist/EO); the NAK detail is
	 * log-only because the metric carries only the bounded side label (plan §Trade-offs 5).
	 */
	recordNak(side: "external" | "internal"): void {
		this.metrics.increment("agent_nak_total", { side });
	}

	/**
	 * Observe one dispatch and derive the dispatch-path alert signals: the dispatch duration
	 * histogram; a missed STATUS heartbeat (`heartbeat_missed` + `agent_heartbeat_age_seconds`)
	 * when the call outlives the protocol heartbeat interval; and a per-dispatch
	 * `agent_budget_overrun_total` when wall clock or tool calls exceed the DISPATCH budget.
	 */
	#observeDispatch(dispatch: DispatchRecord, stage: string, traceId: string, elapsedMs: number, toolTotal: number): void {
		const seconds = elapsedMs / 1000;
		this.metrics.observe("agent_dispatch_duration_seconds", { agent: dispatch.specialist, stage }, seconds);
		if (elapsedMs > (this.opts.heartbeatIntervalMs ?? 30_000)) {
			this.metrics.observe("agent_heartbeat_age_seconds", { agent: "internal" }, seconds);
			const now = this.opts.now ?? (() => new Date().toISOString());
			this.logs.log({
				ts: now(),
				event: "heartbeat_missed",
				trace_id: traceId,
				entry_point: this.entryPoint,
				agent: "internal",
				age_seconds: seconds,
				dispatch_id: dispatch.dispatch_id,
				specialist: dispatch.specialist,
			});
		}
		if (toolTotal > dispatch.budget.tool_calls || seconds > dispatch.budget.seconds) {
			this.metrics.increment("agent_budget_overrun_total", { agent: dispatch.specialist });
		}
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
			// The Gate-3 spec completeness checklist is a separate IO-pipeline increment; here
			// a mounted spec is referenced, not verified. The SHA-match re-verify happens in
			// the EO shim at provisioning (protocol §Session input artifacts); it is recorded
			// here as an ASSUMPTION ledger entry.
			this.#appendLedger({ ts: now(), kind: "ASSUMPTION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `spec mounted at ${task.spec.path} sha=${task.spec.sha} (verify-only use; checklist applies to implement pipelines)`, status: "recorded" });
		}

		this.#appendLedger({ ts: now(), kind: "TASK", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: task.goal, status: "intake" });
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
				return this.#runImplement(task, trace);
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
			this.#appendLedger({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `adversarial gate skipped: ${attach.reason}`, status: "gate_skipped" });
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
			revise: run.revise,
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
				this.#appendLedger({ ts: now(), kind: "DECISION", ref: `gate-iter-${iteration}`, trace_id: task.task_ref, span_id: trace.span_id, summary: `adversarial iteration ${iteration}: ${verdict}${flaws.length ? ` — ${flaws.map((f) => f.claim).join("; ")}` : ""}`, status: verdict === "APPROVED" ? "gate-approved" : verdict === "REJECTED" ? "gate-rejected" : "gate-protocol-invalid" });
			},
			onStructuralFlag: (flag) => {
				this.#appendLedger({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `steel-man structural flag: ${flag.reason}`, status: "gate-structural-flag" });
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

	/**
	 * `implement`: scout → plan → adversarial gate → build → test (design.md Stage 2).
	 * scout grounds the plan — the degrade rule forbids an implement pipeline that skips
	 * it (design.md Stage 3); the gate sits between plan and the build branch and is
	 * skipped (visibly) only when the caller's GateFacts meet no attach criterion. test is
	 * authoritative over build's own claims (Stage 5: test > build).
	 */
	async #runImplement(task: TaskInput, trace: TraceContext): Promise<Extract<HarnessEvent, { type: "completion" | "failure" }>["payload"]> {
		const now = this.opts.now ?? (() => new Date().toISOString());
		const scout = await this.#dispatchSpecialist({
			specialist: "scout",
			task,
			shape: "implement",
			instruction: "Research the objective to ground the implementation plan; return findings per the scout RESULT contract",
			input: { goal: task.goal, constraints: task.constraints },
			span: childSpan(trace),
		});
		if (!scout.ok) return this.#specialistFailure(task, trace, "scout", scout, RESEARCH_FAILURE_RECOVERY);

		const plan = await this.#dispatchSpecialist({
			specialist: "plan",
			task,
			shape: "implement",
			instruction: "Decompose the objective into a dependency-tracked step DAG per the plan RESULT contract",
			input: { goal: task.goal, constraints: task.constraints, scout_findings: scout.value },
			span: childSpan(trace),
		});
		if (!plan.ok) return this.#specialistFailure(task, trace, "plan", plan, PLAN_FAILURE_RECOVERY);
		let planValue: unknown = plan.value;

		// Gate stage. On REJECTED the proposal's owner is the plan specialist, so the revise
		// seam re-dispatches `plan` with the fatal flaws in input.fatal_flaws; a revision that
		// cannot produce a contract-valid plan is a plan failure, not a gate failure.
		const reviseState: { failure: Extract<DispatchOutcome, { ok: false }> | null } = { failure: null };
		const gate = await this.runGate(task, {
			goal: task.goal,
			constraints: task.constraints,
			proposal: this.#planProposal(task.goal, planValue),
			facts: task.gate,
			revise: async (flaws) => {
				const revised = await this.#dispatchSpecialist({
					specialist: "plan",
					task,
					shape: "implement",
					instruction: "Revise the plan to address ONLY the named fatal flaws; return the full plan RESULT contract",
					input: { goal: task.goal, constraints: task.constraints, scout_findings: scout.value, fatal_flaws: flaws },
					span: childSpan(trace),
				});
				if (!revised.ok) {
					reviseState.failure = revised;
					return this.#planProposal(task.goal, planValue);
				}
				planValue = revised.value;
				return this.#planProposal(task.goal, planValue);
			},
		});
		if (reviseState.failure) return this.#specialistFailure(task, trace, "plan", reviseState.failure, PLAN_FAILURE_RECOVERY);
		if (gate.attached && gate.kind !== "approved") return this.#gateFailure(task, trace, gate);

		// `[approval]` stage (design.md Stage 2): the developer answers before the build branch.
		// The wait is observed regardless of outcome; a denial settles as a non-specialist failure.
		if (this.opts.approval) {
			const proposal = this.#planProposal(task.goal, planValue);
			this.logs.log({ ts: now(), event: "approval_requested", trace_id: trace.trace_id, entry_point: this.entryPoint, gate: "approval", action: "build", scope: task.gate?.publishShaped ? "publish" : "sandbox" });
			const decision = await this.opts.approval({ task, goal: task.goal, proposal });
			const waitSeconds = Number.isFinite(decision.waitSeconds) ? Math.max(0, decision.waitSeconds) : 0;
			this.metrics.observe("approval_wait_seconds", {}, waitSeconds);
			this.logs.log({ ts: now(), event: decision.granted ? "approval_granted" : "approval_denied", trace_id: trace.trace_id, entry_point: this.entryPoint, gate: "approval", wait_seconds: waitSeconds, scope: decision.scope ?? "build" });
			if (!decision.granted) return this.#approvalFailure(task, trace, decision.scope ?? "build", waitSeconds);
		}

		const build = await this.#dispatchSpecialist({
			specialist: "build",
			task,
			shape: "implement",
			instruction: "Execute the approved plan; return outcome, changed files, lanes and verification evidence per the build RESULT contract",
			input: { goal: task.goal, constraints: task.constraints, plan: planValue, scout_findings: scout.value, ...(task.target ? { target: task.target } : {}) },
			span: childSpan(trace),
		});
		if (!build.ok) return this.#specialistFailure(task, trace, "build", build, BUILD_FAILURE_RECOVERY);

		const verified = await this.#dispatchSpecialist({
			specialist: "test",
			task,
			shape: "implement",
			instruction: "Verify the build against the objective; classify each test and return the verdict block per the test RESULT contract",
			input: { goal: task.goal, constraints: task.constraints, build: build.value, ...(task.target ? { target: task.target } : {}) },
			span: childSpan(trace),
		});
		if (!verified.ok) return this.#specialistFailure(task, trace, "test", verified, TEST_FAILURE_RECOVERY);

		const buildResult = build.value as { changed_files?: unknown[] };
		const testResult = verified.value as { not_attested?: unknown[]; gaps?: unknown[] };
		const payload = {
			summary: `goal: ${task.goal} — implement pipeline settled: ${gate.attached ? `plan gate-approved (iteration ${gate.iterations})` : "plan gate-skipped"}, build+test contract-valid`,
			verdictAttenuations: [...(testResult.not_attested ?? []), ...(testResult.gaps ?? [])].map(String),
			artifactRefs: (buildResult.changed_files ?? []).map(String),
			ledgerRef: `task:${task.task_ref}`,
		};
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
			evidence: [`unknown pipeline shape "${shape}" (known shapes: research, implement, verify-only, docs-drift, release-notes)`],
			attempts: 0,
			recoveryOptions: ["clarify"],
		};
		this.#appendLedger({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `pipeline shape ${shape} is not a known shape`, status: "settled-failure" });
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
			if (!wireCheck.ok) {
				failures.push(`dispatch wire-invalid: ${wireCheck.errors.join("; ")}`);
				this.recordNak("internal");
			}
			this.#appendLedger({ ts: now(), kind: "DISPATCH", ref: id, trace_id: params.task.task_ref, span_id: params.span.span_id, summary: dispatch.instruction, status: attempt === 1 ? "sent" : "resent-reformed" });
			this.logs.log({ ts: now(), event: "dispatch_sent", trace_id: params.span.trace_id, entry_point: this.entryPoint, dispatch_id: id, specialist: params.specialist, shape: params.shape });
			emit({ type: "status", payload: { stage: `dispatch:${id}`, lastEvent: `${params.specialist} dispatched (attempt ${attempt})` } });

			const runner = this.opts.runners?.[params.specialist] ?? this.opts.runner;
			const startedAt = this.#nowMs();
			let raw: unknown;
			try {
				raw = await runner.run(dispatch);
				const usage = this.opts.usage?.(dispatch, raw);
				if (usage !== undefined) {
					this.metrics.increment("agent_tokens_total", { agent: params.specialist, direction: "prompt" }, usage.prompt);
					this.metrics.increment("agent_tokens_total", { agent: params.specialist, direction: "completion" }, usage.completion);
				}
			} catch (err) {
				this.#observeDispatch(dispatch, params.shape, params.span.trace_id, this.#nowMs() - startedAt, 0);
				failures.push(`attempt ${attempt}: runner error: ${(err as Error).message}`);
				continue;
			}
			let toolTotal = 0;
			for (const use of this.opts.toolCalls?.(dispatch, raw) ?? []) {
				const count = use.count ?? 1;
				toolTotal += count;
				this.metrics.increment("agent_tool_calls_total", { agent: params.specialist, tool_role: use.role }, count);
			}
			this.#observeDispatch(dispatch, params.shape, params.span.trace_id, this.#nowMs() - startedAt, toolTotal);
			const check = checkResult({ specialist: params.specialist, result: raw });
			if (!check.ok) {
				this.metrics.increment("agent_contract_violations_total", { specialist: params.specialist });
				this.recordNak("internal");
				this.logs.log({ ts: now(), event: "contract_violation", trace_id: params.span.trace_id, entry_point: this.entryPoint, dispatch_id: id, specialist: params.specialist, errors: check.errors.slice(0, 3) });
				failures.push(`attempt ${attempt}: contract violation — ${check.errors.slice(0, 3).join("; ")}`);
				continue;
			}
			this.#appendLedger({ ts: now(), kind: "RESULT", ref: id, trace_id: params.task.task_ref, span_id: params.span.span_id, summary: `contract-valid ${params.specialist} RESULT (attempt ${attempt})`, status: "accepted" });
			this.logs.log({ ts: now(), event: "result_received", trace_id: params.span.trace_id, entry_point: this.entryPoint, dispatch_id: id, specialist: params.specialist });
			return { ok: true, value: raw, attempts: attempt };
		}
		return { ok: false, failures, dispatchId: lastDispatchId };
	}

	/** Serialize a plan RESULT into the proposal text the adversarial gate strengthens. */
	#planProposal(goal: string, plan: unknown): string {
		const p = (plan ?? {}) as {
			steps?: { id?: unknown; action?: unknown; done_when?: unknown; binds?: unknown; depends_on?: unknown[] }[];
			assumptions?: { statement?: unknown; status?: unknown }[];
			parallel_groups?: unknown[];
			single_points_of_failure?: unknown[];
		};
		const steps = Array.isArray(p.steps) ? p.steps : [];
		const lines = [`Goal: ${goal}`, "Steps:"];
		for (const step of steps) {
			const binds = step.binds === undefined || step.binds === null || step.binds === "" ? "" : ` | binds: ${String(step.binds)}`;
			const deps = Array.isArray(step.depends_on) && step.depends_on.length > 0 ? ` | depends: ${step.depends_on.map(String).join(", ")}` : "";
			lines.push(`  ${String(step.id ?? "?")}: ${String(step.action ?? "")} | done when: ${String(step.done_when ?? "")}${binds}${deps}`);
		}
		const assumptions = Array.isArray(p.assumptions) ? p.assumptions : [];
		if (assumptions.length > 0) lines.push(`Assumptions: ${assumptions.map((a) => `${String(a.statement ?? "")} [${String(a.status ?? "")}]`).join("; ")}`);
		const groups = Array.isArray(p.parallel_groups) ? p.parallel_groups : [];
		if (groups.length > 0) lines.push(`Parallel groups: ${groups.map((g) => JSON.stringify(g)).join("; ")}`);
		const spof = Array.isArray(p.single_points_of_failure) ? p.single_points_of_failure : [];
		if (spof.length > 0) lines.push(`Single points of failure: ${spof.map(String).join(", ")}`);
		return lines.join("\n");
	}

	/** Terminal FAILURE for an attached gate that did not approve (capped / flag / protocol). */
	#gateFailure(task: TaskInput, trace: TraceContext, gate: Exclude<Extract<GateRunResult, { attached: true }>, { kind: "approved" }>): Extract<HarnessEvent, { type: "failure" }>["payload"] {
		const { ledger, emit, now = () => new Date().toISOString() } = this.opts;
		let evidence: string;
		let recoveryOptions: string[];
		if (gate.kind === "capped") {
			evidence = `adversarial gate hit the iteration cap after ${gate.iterations} iterations; unaddressed fatal flaws: ${gate.flaws.map((f) => f.claim).join("; ") || "none recorded"}`;
			recoveryOptions = GATE_FAILURE_RECOVERY;
		} else if (gate.kind === "structural-flag") {
			evidence = `adversarial gate stopped on a steel-man structural flag after ${gate.iterations} iterations: ${gate.flag.reason}`;
			recoveryOptions = GATE_FAILURE_RECOVERY;
		} else {
			evidence = `adversarial gate could not produce a contract-valid verdict after ${gate.iterations} iterations: ${gate.reason}`;
			recoveryOptions = GATE_PROTOCOL_RECOVERY;
		}
		const payload = {
			failingStep: "gate",
			classification: "gate-failed",
			evidence: [evidence],
			attempts: gate.iterations,
			recoveryOptions,
		};
		this.#appendLedger({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `implement adversarial gate failed (${gate.kind})`, status: "settled-failure" });
		this.metrics.increment("agent_task_total", { agent: "io", outcome: "failure" });
		emit({ type: "failure", payload });
		return payload;
	}

	/** Terminal FAILURE for a denied human approval (design.md Stage 2 `[approval]`). */
	#approvalFailure(task: TaskInput, trace: TraceContext, scope: string, waitSeconds: number): Extract<HarnessEvent, { type: "failure" }>["payload"] {
		const { emit, now = () => new Date().toISOString() } = this.opts;
		const payload = {
			failingStep: "approval",
			classification: "approval-denied",
			evidence: [`developer denied approval for ${scope} after ${waitSeconds}s`],
			attempts: 0,
			recoveryOptions: ["revise-scope", "clarify"],
		};
		this.#appendLedger({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `human approval denied for ${scope} (waited ${waitSeconds}s)`, status: "settled-failure" });
		this.metrics.increment("agent_task_total", { agent: "io", outcome: "failure" });
		emit({ type: "failure", payload });
		return payload;
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
		this.#appendLedger({ ts: now(), kind: "DECISION", ref: result.dispatchId ?? task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: `${specialist} failed after ${result.failures.length} attempts: ${result.failures[0] ?? "no attempts"}`, status: "settled-failure" });
		this.metrics.increment("agent_retry_total", { agent: specialist, lane: task.shape ?? "research" }, Math.max(0, result.failures.length - 1));
		this.metrics.increment("agent_task_total", { agent: "io", outcome: "failure" });
		// Lane exhausted = no automated retry budget remains. Values ride the log (never a
		// metric label) so alerting can distinguish recoverable from unrecoverable failures.
		this.logs.log({
			ts: now(),
			event: "lane_exhausted",
			trace_id: trace.trace_id,
			entry_point: this.entryPoint,
			specialist,
			lane: task.shape ?? "research",
			key: result.dispatchId ?? task.task_ref,
			attempts: result.failures.length,
			recovery_options: recovery,
		});
		emit({ type: "failure", payload });
		return payload;
	}

	#settle(task: TaskInput, trace: TraceContext, payload: Extract<HarnessEvent, { type: "completion" }>["payload"]): void {
		const { ledger, emit, now = () => new Date().toISOString() } = this.opts;
		this.#appendLedger({ ts: now(), kind: "DECISION", ref: task.task_ref, trace_id: task.task_ref, span_id: trace.span_id, summary: payload.summary, status: "settled-completion" });
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
