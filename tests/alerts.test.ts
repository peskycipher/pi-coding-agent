import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { loadYamlFile } from "../evals/harness/config.mjs";
import { ALERT_RULES, evaluateAlerts, fireAlert, PAGE_ALERTS, type AlertWindow } from "../shared/alerts.ts";
import type { LogRecord, MetricSample } from "../shared/telemetry.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const alertsDoc = loadYamlFile(path.join(ROOT, "workflows/observability/alerts.yaml")) as {
	page_alerts?: { name: string; runbook: string }[];
	ticket_alerts?: { name: string; runbook: string }[];
};
const runbooks = readFileSync(path.join(ROOT, "workflows/observability/runbooks.md"), "utf8");

const NOW = "2026-01-02T00:00:00Z";
const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

function counter(name: string, labels: Record<string, string>, sum: number): MetricSample {
	return { name, labels, kind: "counter", count: 1, sum };
}

function histogram(name: string, labels: Record<string, string>, values: number[]): MetricSample {
	return { name, labels, kind: "histogram", count: values.length, sum: values.reduce((a, b) => a + b, 0), values };
}

function log(event: LogRecord["event"], extra: Record<string, unknown> = {}): LogRecord {
	return { ts: minutesAgo(1), event, trace_id: "t-1", entry_point: "internal", ...extra };
}

// One test-fire fixture per rule: each produces a window in which exactly that rule fires.
const FIXTURES: Record<string, () => AlertWindow> = {
	task_failure_unrecoverable: () => ({
		now: NOW,
		ledger: [{ ts: minutesAgo(1), kind: "FAILURE", status: "settled-failure", trace_id: "t-1", recoveryOptions: [] }],
	}),
	pipeline_stalled: () => ({
		now: NOW,
		metrics: [histogram("agent_heartbeat_age_seconds", { agent: "internal" }, [420])],
		logs: [log("dispatch_sent")],
	}),
	completion_gate_rejected: () => ({
		now: NOW,
		sessions: [{ session_id: "s-1", completion_naks_by_task: { "t-1": 2 } }],
	}),
	nak_loop: () => ({
		now: NOW,
		sessions: [{ session_id: "s-1", nak_by_side: { external: 3 } }],
	}),
	contract_violation_rate: () => ({
		now: NOW,
		logs: [log("dispatch_sent"), log("dispatch_sent"), log("contract_violation")],
	}),
	retry_rate_anomaly: () => ({
		now: NOW,
		metrics: [counter("agent_retry_total", { agent: "build", lane: "repair" }, 6)],
		baselines: { retry_7d_per_agent: { build: 2 } },
	}),
	token_burn_anomaly: () => ({
		now: NOW,
		tokenTurns: [
			{ agent: "scout", tokens: 1000 },
			{ agent: "scout", tokens: 900 },
		],
		baselines: { token_p95_30d_per_agent: { scout: 100 } },
	}),
	approval_wait_sla: () => ({
		now: NOW,
		metrics: [histogram("approval_wait_seconds", {}, [100, 2000])],
	}),
	first_attempt_pass_drop: () => ({
		now: NOW,
		firstAttemptRuns: [{ run: "r-1", rate: 0.7 }],
		baselines: { first_attempt_pass_rate: { "r-1": 0.95 } },
	}),
	adversarial_rejection_rate: () => ({
		now: NOW,
		ledger: [
			{ ts: minutesAgo(10), kind: "DECISION", status: "gate-rejected" },
			{ ts: minutesAgo(9), kind: "DECISION", status: "gate-rejected" },
			{ ts: minutesAgo(8), kind: "DECISION", status: "gate-rejected" },
			{ ts: minutesAgo(7), kind: "DECISION", status: "gate-approved" },
		],
	}),
	task_budget_pressure: () => ({
		now: NOW,
		taskBudgets: [{ trace_id: "t-1", used: 850, planned: 1000 }],
	}),
};

test("drift: ALERT_RULES and alerts.yaml cover the same names, severities and runbooks", () => {
	const expected = [
		...(alertsDoc.page_alerts ?? []).map((a) => ({ name: a.name, severity: "page", runbook: a.runbook })),
		...(alertsDoc.ticket_alerts ?? []).map((a) => ({ name: a.name, severity: "ticket", runbook: a.runbook })),
	];
	assert.deepEqual(
		ALERT_RULES.map((r) => r.name).sort(),
		expected.map((e) => e.name).sort(),
		"ALERT_RULES must mirror alerts.yaml (add to both or neither)",
	);
	for (const e of expected) {
		const rule = ALERT_RULES.find((r) => r.name === e.name)!;
		assert.equal(rule.severity, e.severity, e.name);
		assert.equal(rule.runbook, e.runbook, e.name);
	}
});

test("drift: page alerts are the closed set of four (plan §Trade-offs 6)", () => {
	assert.equal(PAGE_ALERTS.length, 4);
});

test("drift: every alert links to an anchored runbook section", () => {
	for (const rule of ALERT_RULES) {
		const anchor = rule.runbook.replace(/^runbooks\.md#/, "");
		assert.ok(new RegExp(`^# ${anchor}\\s*$`, "m").test(runbooks), `missing runbook section #${anchor} for ${rule.name}`);
	}
});

for (const rule of ALERT_RULES) {
	test(`test-fire: ${rule.name} fires on its fixture and stays silent on an empty window`, () => {
		const fixture = FIXTURES[rule.name];
		assert.ok(fixture, `no test-fire fixture for ${rule.name}`);
		const finding = fireAlert(rule.name, fixture());
		assert.ok(finding, `${rule.name} did not fire`);
		assert.equal(finding.severity, rule.severity);
		assert.match(finding.evidence, /\S/);
		assert.equal(fireAlert(rule.name, {}), null, `${rule.name} fired on an empty window`);
	});
}

test("engine: evaluateAlerts reports findings in rule order and throws on unknown names", () => {
	const findings = evaluateAlerts(FIXTURES.contract_violation_rate!());
	assert.ok(findings.some((f) => f.name === "contract_violation_rate"));
	assert.throws(() => fireAlert("not_a_rule", {}), /unknown alert/);
});
