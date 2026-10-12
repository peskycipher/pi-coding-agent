// Alert engine — the executable form of workflows/observability/alerts.yaml
// (workflows/observability/plan.md §Alerting, implementation step 6).
//
// Rules are data (name / severity / runbook link) plus a pure evaluator over an
// `AlertWindow`: the bounded-label metric snapshot and the structured-log records, with
// the few session/baseline projections that are deliberately NOT metric labels
// (session-scoped NAK counts, rolling baselines, raw token turns). The drift discipline
// from README §Conventions is enforced by tests/alerts.test.ts: the rule set, alerts.yaml,
// and runbooks.md cover exactly the same names.
//
// Alert on symptoms, not causes: every rule names an observable failure mode and a start
// threshold; the engine never reads source or guesses intent. Page rules are the closed
// four from the plan (§Trade-offs 6); ticket rules can grow.

import type { LogRecord, MetricSample } from "./telemetry.ts";

export type AlertSeverity = "page" | "ticket";

/** A ledger projection for alert evaluation (the ledger is the system of record). */
export interface AlertLedgerEvent {
	ts: string;
	kind: string;
	status: string;
	trace_id?: string;
	/** terminal FAILURE payload; an explicitly empty array fires task_failure_unrecoverable. */
	recoveryOptions?: readonly string[] | null;
}

/** Session-scoped signals that cannot be bounded metric labels. */
export interface SessionAlertProjection {
	session_id: string;
	/** `agent_nak_total` per side within one session (>2 fires nak_loop). */
	nak_by_side?: Record<string, number>;
	/** EO NAKs of COMPLETION per task_ref (>=2 fires completion_gate_rejected). */
	completion_naks_by_task?: Record<string, number>;
}

/** One specialist turn for the token-burn p95 (from the harness usage record). */
export interface TokenTurn {
	agent: string;
	tokens: number;
}

export interface FirstAttemptRun {
	run: string;
	rate: number;
}

export interface TaskBudgetUsage {
	trace_id: string;
	used: number;
	planned: number;
}

/** Rolling baselines computed by the metrics emitter / EO-side and fed to the engine. */
export interface AlertBaselines {
	/** trailing 7-day retry rate per agent (retry_rate_anomaly). */
	retry_7d_per_agent?: Record<string, number>;
	/** trailing 30-day p95 tokens/turn per agent (token_burn_anomaly). */
	token_p95_30d_per_agent?: Record<string, number>;
	/** trailing first-attempt pass rate per run id (first_attempt_pass_drop). */
	first_attempt_pass_rate?: Record<string, number>;
}

export interface AlertWindow {
	/** evaluation time (ISO); defaults to the newest log/ledger timestamp. */
	now?: string;
	metrics?: readonly MetricSample[];
	logs?: readonly LogRecord[];
	ledger?: readonly AlertLedgerEvent[];
	sessions?: readonly SessionAlertProjection[];
	tokenTurns?: readonly TokenTurn[];
	firstAttemptRuns?: readonly FirstAttemptRun[];
	taskBudgets?: readonly TaskBudgetUsage[];
	baselines?: AlertBaselines;
}

export interface AlertFinding {
	name: string;
	severity: AlertSeverity;
	runbook: string;
	condition: string;
	evidence: string;
}

// Start values from alerts.yaml (kept as named constants so a threshold change is reviewable).
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const STALL_AFTER_S = 300;
const CONTRACT_RATE_WINDOW_MS = 60 * 60 * 1000;
const CONTRACT_RATE_MAX = 0.2;
const RETRY_BASELINE_MULTIPLIER = 2;
const TOKEN_BASELINE_MULTIPLIER = 3;
const APPROVAL_P95_SLA_S = 30 * 60;
const PASS_DROP_POINTS = 0.2;
const ADVERSARIAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const ADVERSARIAL_REJECTION_MAX = 0.5;
const BUDGET_PRESSURE = 0.8;

function windowStart(win: AlertWindow): number {
	if (win.now !== undefined) return Date.parse(win.now);
	let max = 0;
	for (const record of win.logs ?? []) {
		const ts = Date.parse(record.ts);
		if (ts > max) max = ts;
	}
	for (const entry of win.ledger ?? []) {
		const ts = Date.parse(entry.ts);
		if (ts > max) max = ts;
	}
	return max;
}

function within(ts: string, nowMs: number, windowMs: number): boolean {
	const parsed = Date.parse(ts);
	return Number.isFinite(parsed) && nowMs - parsed <= windowMs;
}

function matches(metric: MetricSample, labels: Record<string, string>): boolean {
	return Object.entries(labels).every(([k, v]) => metric.labels[k] === v);
}

/** Sum of a counter's logical value (the `sum` field) across matching samples. */
function counterSum(metrics: readonly MetricSample[], name: string, labels: Record<string, string> = {}): number {
	return metrics.filter((s) => s.name === name && matches(s, labels)).reduce((acc, s) => acc + s.sum, 0);
}

/** Total observation count of a histogram across matching samples. */
function histogramCount(metrics: readonly MetricSample[], name: string, labels: Record<string, string> = {}): number {
	return metrics.filter((s) => s.name === name && matches(s, labels)).reduce((acc, s) => acc + s.count, 0);
}

function histogramValues(metrics: readonly MetricSample[], name: string, labels: Record<string, string> = {}): number[] {
	return metrics.filter((s) => s.name === name && matches(s, labels)).flatMap((s) => s.values ?? []);
}

function maxValue(values: readonly number[]): number | null {
	return values.length > 0 ? Math.max(...values) : null;
}

/** Nearest-rank percentile; `p` in (0, 100]. */
function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export interface AlertRule {
	name: string;
	severity: AlertSeverity;
	runbook: string;
	condition: string;
	/** Evidence string when the rule fires, `null` otherwise. */
	evaluate: (win: AlertWindow) => string | null;
}

function pageRule(name: string, condition: string, evaluate: AlertRule["evaluate"]): AlertRule {
	return { name, severity: "page", runbook: `runbooks.md#${name}`, condition, evaluate };
}

function ticketRule(name: string, condition: string, evaluate: AlertRule["evaluate"]): AlertRule {
	return { name, severity: "ticket", runbook: `runbooks.md#${name}`, condition, evaluate };
}

export const ALERT_RULES: readonly AlertRule[] = [
	pageRule("task_failure_unrecoverable", "count >= 1 in 5m window", (win) => {
		const nowMs = windowStart(win);
		for (const entry of win.ledger ?? []) {
			const terminal = entry.kind === "FAILURE" || entry.status === "settled-failure";
			if (terminal && Array.isArray(entry.recoveryOptions) && entry.recoveryOptions.length === 0 && within(entry.ts, nowMs, FAILURE_WINDOW_MS)) {
				return `terminal FAILURE at ${entry.ts} with empty recoveryOptions${entry.trace_id === undefined ? "" : ` (task ${entry.trace_id})`}`;
			}
		}
		for (const record of win.logs ?? []) {
			const recovery = record.recovery_options;
			if (record.event === "lane_exhausted" && Array.isArray(recovery) && recovery.length === 0 && within(record.ts, nowMs, FAILURE_WINDOW_MS)) {
				return `lane_exhausted with empty recoveryOptions (task ${record.trace_id}, specialist ${String(record.specialist ?? "unknown")})`;
			}
		}
		return null;
	}),

	pageRule("pipeline_stalled", "> 300s while dispatch_count > 0", (win) => {
		const age = maxValue(histogramValues(win.metrics ?? [], "agent_heartbeat_age_seconds", { agent: "internal" }));
		if (age === null || age <= STALL_AFTER_S) return null;
		const sent = (win.logs ?? []).filter((r) => r.event === "dispatch_sent").length;
		const done = (win.logs ?? []).filter((r) => r.event === "result_received").length;
		const outstanding = Math.max(0, sent - done);
		if (outstanding <= 0) return null;
		return `heartbeat age ${age}s > ${STALL_AFTER_S}s with ${outstanding} outstanding dispatch(es)`;
	}),

	pageRule("completion_gate_rejected", ">= 2 for the same task_ref", (win) => {
		for (const session of win.sessions ?? []) {
			for (const [task, count] of Object.entries(session.completion_naks_by_task ?? {})) {
				if (count >= 2) return `task ${task} completion NAKed ${count} times in session ${session.session_id}`;
			}
		}
		return null;
	}),

	pageRule("nak_loop", "> 2 per session", (win) => {
		for (const session of win.sessions ?? []) {
			for (const [side, count] of Object.entries(session.nak_by_side ?? {})) {
				if (count > 2) return `${count} NAKs from side "${side}" in session ${session.session_id} — protocol drift`;
			}
		}
		return null;
	}),

	ticketRule("contract_violation_rate", "agent_contract_violations_total / dispatches > 20% over 1h", (win) => {
		const nowMs = windowStart(win);
		const logs = win.logs ?? [];
		const dispatches = logs.filter((r) => r.event === "dispatch_sent" && within(r.ts, nowMs, CONTRACT_RATE_WINDOW_MS)).length;
		const violations = logs.filter((r) => r.event === "contract_violation" && within(r.ts, nowMs, CONTRACT_RATE_WINDOW_MS)).length;
		if (dispatches > 0) {
			const rate = violations / dispatches;
			return rate > CONTRACT_RATE_MAX ? `${(rate * 100).toFixed(0)}% contract violations (${violations}/${dispatches}) over 1h` : null;
		}
		const metricDispatches = histogramCount(win.metrics ?? [], "agent_dispatch_duration_seconds");
		const metricViolations = counterSum(win.metrics ?? [], "agent_contract_violations_total");
		if (metricDispatches > 0 && metricViolations / metricDispatches > CONTRACT_RATE_MAX) {
			return `${(100 * metricViolations / metricDispatches).toFixed(0)}% contract violations (${metricViolations}/${metricDispatches})`;
		}
		return null;
	}),

	ticketRule("retry_rate_anomaly", "> 2x trailing 7-day baseline per agent", (win) => {
		const baselines = win.baselines?.retry_7d_per_agent ?? {};
		for (const [agent, baseline] of Object.entries(baselines)) {
			if (baseline <= 0) continue;
			const current = counterSum(win.metrics ?? [], "agent_retry_total", { agent });
			if (current > RETRY_BASELINE_MULTIPLIER * baseline) {
				return `agent ${agent} retries ${current} > ${RETRY_BASELINE_MULTIPLIER}x trailing baseline ${baseline}`;
			}
		}
		return null;
	}),

	ticketRule("token_burn_anomaly", "p95 tokens/turn > 3x 30-day baseline per agent", (win) => {
		const baselines = win.baselines?.token_p95_30d_per_agent ?? {};
		for (const [agent, baseline] of Object.entries(baselines)) {
			if (baseline <= 0) continue;
			const p95 = percentile((win.tokenTurns ?? []).filter((t) => t.agent === agent).map((t) => t.tokens), 95);
			if (p95 > TOKEN_BASELINE_MULTIPLIER * baseline) {
				return `agent ${agent} p95 ${p95} tokens/turn > ${TOKEN_BASELINE_MULTIPLIER}x baseline ${baseline}`;
			}
		}
		return null;
	}),

	ticketRule("approval_wait_sla", "approval_wait_seconds p95 > 30min", (win) => {
		const values = histogramValues(win.metrics ?? [], "approval_wait_seconds");
		if (values.length === 0) return null;
		const p95 = percentile(values, 95);
		return p95 > APPROVAL_P95_SLA_S ? `approval_wait p95 ${p95}s > ${APPROVAL_P95_SLA_S}s` : null;
	}),

	ticketRule("first_attempt_pass_drop", "test agent first-attempt pass rate drop > 20pts per run", (win) => {
		const baselines = win.baselines?.first_attempt_pass_rate ?? {};
		for (const run of win.firstAttemptRuns ?? []) {
			const baseline = baselines[run.run];
			if (baseline !== undefined && baseline - run.rate > PASS_DROP_POINTS) {
				return `run ${run.run} first-attempt pass rate ${run.rate} dropped ${(baseline - run.rate).toFixed(2)} below baseline ${baseline}`;
			}
		}
		return null;
	}),

	ticketRule("adversarial_rejection_rate", "> 50% of adversarial gate outcomes are REJECTED across tasks in 24h", (win) => {
		const nowMs = windowStart(win);
		const ledger = win.ledger ?? [];
		const approved = ledger.filter((e) => e.status === "gate-approved" && within(e.ts, nowMs, ADVERSARIAL_WINDOW_MS)).length;
		const rejected = ledger.filter((e) => e.status === "gate-rejected" && within(e.ts, nowMs, ADVERSARIAL_WINDOW_MS)).length;
		const total = approved + rejected;
		if (total === 0) return null;
		const rate = rejected / total;
		return rate > ADVERSARIAL_REJECTION_MAX ? `${(rate * 100).toFixed(0)}% of ${total} gate outcomes REJECTED in 24h` : null;
	}),

	ticketRule("task_budget_pressure", "task-level tokens or wall-clock >= 80% of the TASK budget", (win) => {
		for (const budget of win.taskBudgets ?? []) {
			if (budget.planned > 0 && budget.used / budget.planned >= BUDGET_PRESSURE) {
				return `task ${budget.trace_id} at ${Math.round((100 * budget.used) / budget.planned)}% of budget (${budget.used}/${budget.planned})`;
			}
		}
		return null;
	}),
];

export const PAGE_ALERTS: readonly AlertRule[] = ALERT_RULES.filter((rule) => rule.severity === "page");
export const TICKET_ALERTS: readonly AlertRule[] = ALERT_RULES.filter((rule) => rule.severity === "ticket");

/** Evaluate every rule over the window; deterministic rule order. */
export function evaluateAlerts(win: AlertWindow): AlertFinding[] {
	const findings: AlertFinding[] = [];
	for (const rule of ALERT_RULES) {
		const evidence = rule.evaluate(win);
		if (evidence !== null) findings.push({ name: rule.name, severity: rule.severity, runbook: rule.runbook, condition: rule.condition, evidence });
	}
	return findings;
}

/** Test-fire one rule by name (plan §step 6 harness seam); returns the finding or null. */
export function fireAlert(name: string, win: AlertWindow): AlertFinding | null {
	const rule = ALERT_RULES.find((candidate) => candidate.name === name);
	if (rule === undefined) throw new Error(`unknown alert "${name}" — add it to ALERT_RULES and alerts.yaml together`);
	const evidence = rule.evaluate(win);
	return evidence === null ? null : { name: rule.name, severity: rule.severity, runbook: rule.runbook, condition: rule.condition, evidence };
}
