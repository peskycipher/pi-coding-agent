// Telemetry exporter — the read side of the observability emitters in shared/telemetry.ts
// (workflows/observability/plan.md §Storage and viewing, implementation step 5).
//
// `Metrics.snapshot()` is rendered as Prometheus text exposition so any Prometheus-
// compatible sink (self-hosted Prometheus + Grafana, or the Langfuse environment's
// metrics option) can scrape the RED board; structured `LogRecord`s are rendered as one
// JSONL file per task (`<trace_id>.jsonl`) so a debugging session can `jq` a failing run
// with no infrastructure. Both halves are pure and dependency-free: the Worker bundle and
// Node tests share them; file durability belongs to the caller's `write` callback.
//
// The parser is the reader half: acceptance/debug tooling reconstructs a run from the
// exported artifacts alone (tests/observability-acceptance.test.ts).

import type { LogRecord, LogSink, MetricSample } from "./telemetry.ts";

/** Log root from plan.md §Storage and viewing (`~/.agent-suite/logs/<trace_id>.jsonl`). */
export const DEFAULT_LOG_ROOT = "~/.agent-suite/logs";

/** Histogram bucket boundaries, in the metric's unit (latency metrics use seconds). */
export const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800,
];

function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
	if (Number.isFinite(value)) return String(value);
	if (Number.isNaN(value)) return "NaN";
	return value > 0 ? "+Inf" : "-Inf";
}

function renderLabels(labels: Record<string, string>, extra?: [string, string]): string {
	const entries = Object.keys(labels)
		.sort()
		.map((k) => [k, labels[k]] as [string, string]);
	if (extra !== undefined) entries.push(extra);
	if (entries.length === 0) return "";
	return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")}}`;
}

function cumulativeBuckets(values: readonly number[], buckets: readonly number[]): { le: string; count: number }[] {
	const sorted = [...values].sort((a, b) => a - b);
	const out: { le: string; count: number }[] = [];
	let idx = 0;
	for (const boundary of buckets) {
		while (idx < sorted.length && sorted[idx]! <= boundary) idx += 1;
		out.push({ le: formatNumber(boundary), count: idx });
	}
	out.push({ le: "+Inf", count: sorted.length });
	return out;
}

/** Render a `Metrics.snapshot()` as Prometheus text exposition (0.0.4 format). */
export function toPrometheus(snapshot: readonly MetricSample[], buckets: readonly number[] = DEFAULT_HISTOGRAM_BUCKETS): string {
	const byName = new Map<string, MetricSample[]>();
	for (const sample of snapshot) {
		const list = byName.get(sample.name) ?? [];
		list.push(sample);
		byName.set(sample.name, list);
	}
	const lines: string[] = [];
	for (const name of [...byName.keys()].sort()) {
		const samples = byName.get(name)!;
		const kind = samples[0]!.kind;
		lines.push(`# HELP ${name} agent-suite ${kind} (workflows/observability/plan.md §Metrics)`);
		lines.push(`# TYPE ${name} ${kind === "histogram" ? "histogram" : "counter"}`);
		for (const sample of samples) {
			if (sample.kind === "histogram") {
				for (const bucket of cumulativeBuckets(sample.values ?? [], buckets)) {
					lines.push(`${name}_bucket${renderLabels(sample.labels, ["le", bucket.le])} ${formatNumber(bucket.count)}`);
				}
				lines.push(`${name}_sum${renderLabels(sample.labels)} ${formatNumber(sample.sum)}`);
				lines.push(`${name}_count${renderLabels(sample.labels)} ${formatNumber(sample.count)}`);
			} else {
				// counters: `sum` is the logical value (increment adds `value`, count counts calls)
				lines.push(`${name}${renderLabels(sample.labels)} ${formatNumber(sample.sum)}`);
			}
		}
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export interface ParsedMetric {
	name: string;
	labels: Record<string, string>;
	value: number;
}

function parseLabelString(input: string): Record<string, string> {
	const labels: Record<string, string> = {};
	let i = 0;
	while (i < input.length) {
		while (i < input.length && (input[i] === "," || input[i] === " ")) i += 1;
		if (i >= input.length) break;
		const eq = input.indexOf("=", i);
		if (eq === -1) break;
		const key = input.slice(i, eq).trim();
		i = eq + 1;
		if (input[i] !== '"') break;
		i += 1;
		let value = "";
		while (i < input.length && input[i] !== '"') {
			if (input[i] === "\\" && i + 1 < input.length) {
				const next = input[i + 1]!;
				value += next === "n" ? "\n" : next;
				i += 2;
			} else {
				value += input[i]!;
				i += 1;
			}
		}
		i += 1;
		if (key !== "") labels[key] = value;
	}
	return labels;
}

/** Parse Prometheus text exposition back into samples — the reader half of `toPrometheus`. */
export function parsePrometheusText(text: string): ParsedMetric[] {
	const parsed: ParsedMetric[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const spaceIdx = line.lastIndexOf(" ");
		if (spaceIdx === -1) continue;
		const token = line.slice(spaceIdx + 1);
		const value = token === "+Inf" ? Number.POSITIVE_INFINITY : token === "-Inf" ? Number.NEGATIVE_INFINITY : Number(token);
		if (Number.isNaN(value)) continue;
		const nameAndLabels = line.slice(0, spaceIdx);
		const braceStart = nameAndLabels.indexOf("{");
		let name = nameAndLabels;
		let labels: Record<string, string> = {};
		if (braceStart !== -1) {
			name = nameAndLabels.slice(0, braceStart);
			const braceEnd = nameAndLabels.lastIndexOf("}");
			labels = parseLabelString(nameAndLabels.slice(braceStart + 1, braceEnd));
		}
		parsed.push({ name, labels, value });
	}
	return parsed;
}

/** First parsed sample matching `name` and every label in `labels`. */
export function findMetric(parsed: readonly ParsedMetric[], name: string, labels: Record<string, string> = {}): ParsedMetric | undefined {
	return parsed.find((m) => m.name === name && Object.entries(labels).every(([k, v]) => m.labels[k] === v));
}

/** Value of the first matching sample, or 0 when absent. */
export function metricValue(parsed: readonly ParsedMetric[], name: string, labels: Record<string, string> = {}): number {
	return findMetric(parsed, name, labels)?.value ?? 0;
}

/** `<trace_id>.jsonl`, with path-free characters so a task ref cannot escape the log root. */
export function taskLogFileName(traceId: string): string {
	const safe = traceId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 128);
	return `${safe === "" ? "task" : safe}.jsonl`;
}

export function taskLogPath(root: string, traceId: string): string {
	return `${root.replace(/\/+$/, "")}/${taskLogFileName(traceId)}`;
}

/** Serialize records as JSONL (one record per line, trailing newline when non-empty). */
export function toJsonl(records: readonly LogRecord[]): string {
	return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

/** Writes one structured line per record to `<root>/<trace_id>.jsonl`. */
export class TaskJsonlSink implements LogSink {
	private readonly write: (path: string, line: string) => void;
	private readonly root: string;

	constructor(write: (path: string, line: string) => void, root: string = DEFAULT_LOG_ROOT) {
		this.write = write;
		this.root = root;
	}

	log(record: LogRecord): void {
		this.write(taskLogPath(this.root, record.trace_id), `${JSON.stringify(record)}\n`);
	}
}
