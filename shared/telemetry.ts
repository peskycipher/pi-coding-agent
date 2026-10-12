// Observability emitters — the executable form of workflows/observability/plan.md
// (implementation steps 1–4: trace stamping, metric vocabulary, structured logs).
//
// Scope: the suite's own signal vocabulary, not a vendor client. Emitters are pure and
// dependency-free so the IO harness can run them in the Worker bundle or in Node tests;
// an OTel/Langfuse exporter is a consumer of `Metrics.snapshot()` / the log sink.
//
// Rules enforced here, not by convention (plan §Trade-offs 5):
//  - metric labels are a fixed, bounded set per metric name; a label the plan did not
//    declare is a programming error and throws, so task refs / file paths / error text
//    can never become labels;
//  - label values are short and path-free, for the same reason;
//  - structured logs carry values (trace ids, evidence) while metrics carry only counts.

/** Trace context per the plan's §Trace ID model: `trace_id` defaults to the task ref. */
export interface TraceContext {
	trace_id: string;
	span_id: string;
	parent_span_id: string | null;
}

let spanCounter = 0;

/** Monotonic, process-unique span id. Kept short and opaque — ids are never semantic. */
export function newSpanId(): string {
	spanCounter += 1;
	return `s${spanCounter.toString(36)}`;
}

/** Root span for a task: `trace_id` is the task_ref, no parent. */
export function rootSpan(traceId: string): TraceContext {
	return { trace_id: traceId, span_id: newSpanId(), parent_span_id: null };
}

/** Child span for a dispatch/result beneath an existing trace context. */
export function childSpan(parent: TraceContext): TraceContext {
	return { trace_id: parent.trace_id, span_id: newSpanId(), parent_span_id: parent.span_id };
}

/** The metric label vocabulary from plan.md §Metrics. Names absent here are not emitted. */
export const METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
	agent_task_total: ["agent", "outcome"],
	agent_dispatch_duration_seconds: ["agent", "stage"],
	agent_tokens_total: ["agent", "direction"],
	agent_tool_calls_total: ["agent", "tool_role"],
	agent_contract_violations_total: ["specialist"],
	agent_retry_total: ["agent", "lane"],
	agent_budget_overrun_total: ["agent"],
	agent_loop_iterations_total: ["agent", "gate"],
	agent_gate_skipped_total: ["gate"],
	agent_docs_stale_claims_total: ["risk_class"],
	agent_nak_total: ["side"],
	approval_wait_seconds: [],
	agent_heartbeat_age_seconds: ["agent"],
};

/** Histogram metrics (the rest are counters). */
const HISTOGRAMS = new Set(["agent_dispatch_duration_seconds", "approval_wait_seconds", "agent_heartbeat_age_seconds"]);

export type MetricLabels = Record<string, string | number | boolean>;

export interface MetricSample {
	name: string;
	labels: Record<string, string>;
	kind: "counter" | "histogram";
	count: number;
	sum: number;
	/** Histogram observations, in arrival order (counters carry none). */
	values?: number[];
}

// A bounded label value: no slashes (paths), no newlines, short. `:` allows stage labels.
const BOUNDED_VALUE = /^[A-Za-z0-9_.:+-]{1,64}$/;

function keyOf(name: string, labels: Record<string, string>): string {
	const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
	return `${name}{${parts.join(",")}}`;
}

/**
 * In-memory, bounded-label metric registry. Callers increment counters and observe
 * histograms; `snapshot()` is what an exporter (or a test) reads.
 */
export class Metrics {
	private readonly samples = new Map<string, MetricSample>();

	private normalize(name: string, labels: MetricLabels): { key: string; labels: Record<string, string> } {
		const allowed = METRIC_LABELS[name];
		if (allowed === undefined) throw new Error(`unknown metric "${name}" — add it to METRIC_LABELS with bounded labels`);
		const clean: Record<string, string> = {};
		for (const [k, v] of Object.entries(labels)) {
			if (!allowed.includes(k)) throw new Error(`metric ${name}: undeclared label "${k}" (cardinality guard)`);
			const value = String(v);
			if (!BOUNDED_VALUE.test(value)) throw new Error(`metric ${name}: label ${k}="${value}" is not a bounded label value`);
			clean[k] = value;
		}
		return { key: keyOf(name, clean), labels: clean };
	}

	private sampleFor(name: string, labels: MetricLabels): MetricSample {
		const { key, labels: clean } = this.normalize(name, labels);
		let sample = this.samples.get(key);
		if (sample === undefined) {
			const kind = HISTOGRAMS.has(name) ? "histogram" : "counter";
			sample = { name, labels: clean, kind, count: 0, sum: 0, ...(kind === "histogram" ? { values: [] } : {}) };
			this.samples.set(key, sample);
		}
		return sample;
	}

	/** Increment a counter (or add to a histogram's running sum). */
	increment(name: string, labels: MetricLabels = {}, value = 1): void {
		const sample = this.sampleFor(name, labels);
		sample.count += 1;
		sample.sum += value;
		if (sample.kind === "histogram") sample.values!.push(value);
	}

	/** Observe a histogram value (alias of `increment` with a numeric observation). */
	observe(name: string, labels: MetricLabels, value: number): void {
		if (!HISTOGRAMS.has(name)) throw new Error(`metric ${name} is not a histogram`);
		this.increment(name, labels, value);
	}

	/** All samples, deterministically ordered by their serialized key. */
	snapshot(): MetricSample[] {
		return [...this.samples.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => ({
			...s,
			...(s.values === undefined ? {} : { values: [...s.values] }),
		}));
	}

	/** Current value of one counter/histogram (0 when never observed). */
	value(name: string, labels: MetricLabels = {}): number {
		return this.samples.get(this.normalize(name, labels).key)?.sum ?? 0;
	}
}

/** Structured log event names from plan.md §Logs. */
export type LogEvent =
	| "task_received"
	| "dispatch_sent"
	| "result_received"
	| "contract_violation"
	| "lane_exhausted"
	| "escalation_raised"
	| "approval_requested"
	| "approval_granted"
	| "approval_denied"
	| "artifact_exported"
	| "ledger_appended"
	| "heartbeat_missed"
	| "gate_attached"
	| "gate_skipped"
	| "docs_drift_detected";

export interface LogRecord {
	ts: string;
	event: LogEvent;
	trace_id: string;
	entry_point: string;
	[key: string]: unknown;
}

/** Minimal sink the harness writes to; the plan's JSONL-per-task file is one impl. */
export interface LogSink {
	log(record: LogRecord): void;
}

/** Collects records in memory (tests, and the default no-op-ish harness sink). */
export class MemoryLogSink implements LogSink {
	readonly records: LogRecord[] = [];
	log(record: LogRecord): void {
		this.records.push(record);
	}
}

/** A sink that drops records — used when no telemetry sink is configured. */
export const NULL_LOG_SINK: LogSink = { log: () => {} };
