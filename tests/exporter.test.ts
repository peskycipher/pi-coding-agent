import assert from "node:assert/strict";
import { test } from "node:test";

import { Metrics } from "../shared/telemetry.ts";
import {
	findMetric,
	metricValue,
	parsePrometheusText,
	TaskJsonlSink,
	taskLogFileName,
	taskLogPath,
	toJsonl,
	toPrometheus,
} from "../shared/exporter.ts";

test("exporter: counters render as Prometheus text and round-trip", () => {
	const metrics = new Metrics();
	metrics.increment("agent_task_total", { agent: "io", outcome: "completion" });
	metrics.increment("agent_task_total", { agent: "io", outcome: "completion" });
	metrics.increment("agent_contract_violations_total", { specialist: "scout" }, 3);

	const text = toPrometheus(metrics.snapshot());
	assert.match(text, /# TYPE agent_task_total counter/);
	assert.match(text, /agent_task_total\{agent="io",outcome="completion"\} 2/);
	assert.match(text, /agent_contract_violations_total\{specialist="scout"\} 3/);

	const parsed = parsePrometheusText(text);
	assert.equal(metricValue(parsed, "agent_task_total", { agent: "io", outcome: "completion" }), 2);
	assert.equal(metricValue(parsed, "agent_contract_violations_total", { specialist: "scout" }), 3);
	assert.equal(metricValue(parsed, "agent_task_total", { agent: "nobody" }), 0);
});

test("exporter: histograms render buckets, _sum and _count", () => {
	const metrics = new Metrics();
	metrics.observe("agent_dispatch_duration_seconds", { agent: "scout", stage: "research" }, 0.5);
	metrics.observe("agent_dispatch_duration_seconds", { agent: "scout", stage: "research" }, 1.5);

	const text = toPrometheus(metrics.snapshot());
	assert.match(text, /# TYPE agent_dispatch_duration_seconds histogram/);
	assert.match(text, /agent_dispatch_duration_seconds_bucket\{agent="scout",stage="research",le="1"\} 1/);
	assert.match(text, /agent_dispatch_duration_seconds_bucket\{agent="scout",stage="research",le="\+Inf"\} 2/);
	assert.match(text, /agent_dispatch_duration_seconds_sum\{agent="scout",stage="research"\} 2/);
	assert.match(text, /agent_dispatch_duration_seconds_count\{agent="scout",stage="research"\} 2/);

	const parsed = parsePrometheusText(text);
	assert.equal(metricValue(parsed, "agent_dispatch_duration_seconds_count", { agent: "scout", stage: "research" }), 2);
	assert.equal(metricValue(parsed, "agent_dispatch_duration_seconds_sum", { agent: "scout", stage: "research" }), 2);
	// cumulative buckets: both observations are <= 2.5, only the first is <= 1
	assert.equal(findMetric(parsed, "agent_dispatch_duration_seconds_bucket", { le: "1" })?.value, 1);
	assert.equal(findMetric(parsed, "agent_dispatch_duration_seconds_bucket", { le: "2.5" })?.value, 2);
	assert.equal(findMetric(parsed, "agent_dispatch_duration_seconds_bucket", { le: "+Inf" })?.value, 2);
});

test("exporter: label values are escaped so JSON/injection text cannot break the format", () => {
	const metrics = new Metrics();
	metrics.increment("agent_docs_stale_claims_total", { risk_class: "wrong-instruction" });
	// bounded-value guard allows a quote? it does not, so exercise the escaper directly.
	assert.equal(parsePrometheusText('metric{a="x\\"y"} 1')[0].labels.a, 'x"y');
	assert.equal(toPrometheus(metrics.snapshot()).startsWith("# HELP agent_docs_stale_claims_total"), true);
});

test("exporter: task log layout is path-free and routes by trace id", () => {
	assert.equal(taskLogFileName("t-1"), "t-1.jsonl");
	assert.equal(taskLogFileName("../../etc/passwd"), "_.._etc_passwd.jsonl");
	assert.equal(taskLogFileName("..."), "task.jsonl");
	assert.equal(taskLogPath("/root/", "t-1"), "/root/t-1.jsonl");

	const writes: { path: string; line: string }[] = [];
	const sink = new TaskJsonlSink((path, line) => writes.push({ path, line }), "/logs");
	sink.log({ ts: "2026-01-01T00:00:00Z", event: "task_received", trace_id: "t-1", entry_point: "internal" });
	sink.log({ ts: "2026-01-01T00:00:01Z", event: "result_received", trace_id: "t-2", entry_point: "internal" });
	assert.deepEqual(writes.map((w) => w.path), ["/logs/t-1.jsonl", "/logs/t-2.jsonl"]);
	assert.equal(JSON.parse(writes[0]!.line).event, "task_received");
});

test("exporter: JSONL body is one record per line with a trailing newline", () => {
	const records = [
		{ ts: "2026-01-01T00:00:00Z", event: "task_received", trace_id: "t-1", entry_point: "internal" },
		{ ts: "2026-01-01T00:00:01Z", event: "result_received", trace_id: "t-1", entry_point: "internal" },
	] as const;
	const body = toJsonl(records);
	assert.equal(body.split("\n").filter(Boolean).length, 2);
	assert.equal(body.endsWith("\n"), true);
	assert.equal(toJsonl([]), "");
});
