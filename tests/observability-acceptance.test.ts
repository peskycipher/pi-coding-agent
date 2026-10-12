import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateAlerts } from "../shared/alerts.ts";
import { metricValue, parsePrometheusText, toJsonl, toPrometheus } from "../shared/exporter.ts";
import { InMemoryLedger, IoHarness, type HarnessEvent, type SpecialistRunner } from "../shared/io.ts";
import { MemoryLogSink, Metrics } from "../shared/telemetry.ts";

// Plan §Implementation step 7: force a failure in a scratch task, then reconstruct cause,
// latency, and token profile from telemetry alone. The assertions below deliberately read
// only the exported artifacts (Prometheus text + JSONL) — not the harness objects — so the
// test fails if the emitters stop carrying enough to debug a run without reading source.

test("acceptance: a forced specialist failure is reconstructable from telemetry alone", async () => {
	const metrics = new Metrics();
	const logs = new MemoryLogSink();
	const ledger = new InMemoryLedger();
	const events: HarnessEvent[] = [];
	// The scout never produces a contract-valid RESULT, so the one re-formed retry also fails.
	const runner: SpecialistRunner = { async run() { return { verdicts: [] }; } };
	// Deterministic usage record per turn; the retry spends it twice.
	const usage = { scout: { prompt: 1200, completion: 90 } };
	const harness = new IoHarness({
		ledger,
		emit: (event) => events.push(event),
		runner,
		metrics,
		logs,
		usage: (dispatch) => usage[dispatch.specialist],
	});

	const failure = (await harness.runTask({ task_ref: "scratch-fail-1", goal: "force a failure", shape: "research" })) as {
		classification: string;
		recoveryOptions: string[];
		attempts: number;
	};
	assert.equal(failure.classification, "specialist-failed");
	assert.equal(failure.attempts, 2);

	// --- telemetry boundary: only the exported artifacts cross this line ---
	const prometheus = toPrometheus(metrics.snapshot());
	const jsonl = toJsonl(logs.records);

	const records = jsonl
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const parsed = parsePrometheusText(prometheus);

	// Cause: two contract violations, then the exhausted lane naming specialist + objective.
	const violations = records.filter((r) => r.event === "contract_violation");
	assert.equal(violations.length, 2);
	assert.equal(violations[0]!.specialist, "scout");
	assert.ok(Array.isArray(violations[0]!.errors) && (violations[0]!.errors as unknown[]).length > 0, "violation carries the missing-field evidence");
	assert.equal(metricValue(parsed, "agent_contract_violations_total", { specialist: "scout" }), 2);

	const exhausted = records.find((r) => r.event === "lane_exhausted");
	assert.ok(exhausted, "terminal lane exhaustion is logged");
	assert.equal(exhausted!.specialist, "scout");
	assert.equal(exhausted!.lane, "research");
	assert.equal(exhausted!.attempts, 2);
	assert.deepEqual(exhausted!.recovery_options, ["re-dispatch:scout", "clarify"]);

	// Latency: both attempts are observed, so the histogram carries the retry cost.
	assert.equal(metricValue(parsed, "agent_dispatch_duration_seconds_count", { agent: "scout", stage: "research" }), 2);

	// Token profile: each turn's prompt/completion spend is on the counter; the retry doubled it.
	assert.equal(metricValue(parsed, "agent_tokens_total", { agent: "scout", direction: "prompt" }), 2400);
	assert.equal(metricValue(parsed, "agent_tokens_total", { agent: "scout", direction: "completion" }), 180);

	// The same window fires the expected ticket alert and none of the page alerts.
	const findings = evaluateAlerts({ now: new Date().toISOString(), metrics: metrics.snapshot(), logs: logs.records });
	assert.ok(findings.some((f) => f.name === "contract_violation_rate" && f.severity === "ticket"));
	assert.deepEqual(findings.filter((f) => f.severity === "page"), []);
});
