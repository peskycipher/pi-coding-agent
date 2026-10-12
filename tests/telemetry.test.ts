import assert from "node:assert/strict";
import { test } from "node:test";

import {
	childSpan,
	MemoryLogSink,
	Metrics,
	newSpanId,
	rootSpan,
} from "../shared/telemetry.ts";

test("trace spans: root carries trace_id, child links parent", () => {
	const root = rootSpan("t-1");
	assert.equal(root.trace_id, "t-1");
	assert.equal(root.parent_span_id, null);
	const child = childSpan(root);
	assert.equal(child.trace_id, "t-1");
	assert.equal(child.parent_span_id, root.span_id);
	assert.notEqual(child.span_id, root.span_id);
	assert.notEqual(newSpanId(), newSpanId());
});

test("metrics: counters accumulate and snapshot is deterministic", () => {
	const m = new Metrics();
	m.increment("agent_task_total", { agent: "io", outcome: "completion" });
	m.increment("agent_task_total", { agent: "io", outcome: "completion" });
	assert.equal(m.value("agent_task_total", { agent: "io", outcome: "completion" }), 2);
	m.increment("agent_contract_violations_total", { specialist: "scout" }, 3);
	const snap = m.snapshot();
	assert.equal(snap.length, 2);
	assert.deepEqual(snap.map((s) => s.name), ["agent_contract_violations_total", "agent_task_total"]);
});

test("metrics: histograms retain observations", () => {
	const m = new Metrics();
	m.observe("agent_dispatch_duration_seconds", { agent: "scout", stage: "research" }, 1.5);
	m.observe("agent_dispatch_duration_seconds", { agent: "scout", stage: "research" }, 0.5);
	const [sample] = m.snapshot();
	assert.equal(sample.kind, "histogram");
	assert.equal(sample.count, 2);
	assert.equal(sample.sum, 2);
	assert.deepEqual(sample.values, [1.5, 0.5]);
});

test("metrics: undeclared metric and label are rejected (cardinality guard)", () => {
	const m = new Metrics();
	assert.throws(() => m.increment("agent_made_up_total", { agent: "io" }), /unknown metric/);
	assert.throws(() => m.increment("agent_task_total", { agent: "io", task_ref: "t-1" } as never), /undeclared label/);
	assert.throws(() => m.increment("agent_task_total", { agent: "io", outcome: "/etc/passwd" }), /bounded label/);
});

test("logs: MemoryLogSink records structured events", () => {
	const sink = new MemoryLogSink();
	sink.log({ ts: "2026-01-01T00:00:00Z", event: "gate_skipped", trace_id: "t-1", entry_point: "internal", reason: "no criterion" });
	assert.equal(sink.records.length, 1);
	assert.equal(sink.records[0].event, "gate_skipped");
});
