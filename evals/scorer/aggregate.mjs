// Suite aggregation, result-line shaping, and regression/baseline tracking
// (spec: workflows/test-eval-spec.md §4.3/§6).
//
// Result lines feed evals/results/<date>/<model>.jsonl; baselines/current.json keeps the
// per-scenario last-5-run pass flags + score trends. A core regression blocks the PR.

const DIMENSIONS = ["M1", "M2", "M3", "M4"];

/** Aggregate a set of `scoreRun` outputs into the suite summary. */
export function aggregateSuite(results) {
	const total = results.length;
	const passes = results.filter((r) => r.pass).length;
	const dimensions = {};
	for (const dim of DIMENSIONS) {
		const values = results.map((r) => r.dimensions?.[dim]).filter((v) => typeof v === "number");
		dimensions[dim] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 1;
	}
	const m1 = results.filter((r) => r.agent !== "docs").map((r) => r.m1Score).filter((v) => typeof v === "number");
	const m1p = results.filter((r) => r.agent === "docs").map((r) => r.m1pScore).filter((v) => typeof v === "number");
	return {
		total,
		passes,
		passRate: total ? passes / total : 0,
		dimensions,
		m1Mean: m1.length ? m1.reduce((a, b) => a + b, 0) / m1.length : null,
		m1pMean: m1p.length ? m1p.reduce((a, b) => a + b, 0) / m1p.length : null,
		unsafeRuns: results.filter((r) => r.unsafe).map((r) => r.scenario),
		safetyViolations: results.flatMap((r) => (r.safetyViolations ?? []).map((id) => `${r.scenario}:${id}`)),
		perScenario: Object.fromEntries(results.map((r) => [r.scenario, { pass: r.pass, score: r.m1Score, unsafe: r.unsafe }])),
	};
}

/** Shape one result line per spec §4.3: {candidate, model, scenario, checks, judge, tokens, seconds}. */
export function toResultLine(score, meta = {}) {
	return {
		candidate: meta.candidate ?? "unknown",
		model: meta.model ?? "unknown",
		scenario: score.scenario,
		checks: {
			M1: score.dimensions?.M1 ?? null,
			M2: score.dimensions?.M2 ?? null,
			M3: score.dimensions?.M3 ?? null,
			M4: score.dimensions?.M4 ?? null,
			S: score.unsafe ? 0 : 1,
		},
		pass: score.pass,
		safetyViolations: score.safetyViolations ?? [],
		judge: meta.judge ?? null,
		tokens: meta.tokens ?? 0,
		seconds: meta.seconds ?? 0,
	};
}

/** Load-time validation: a baseline must expose a scenarios map. */
export function emptyBaseline(now = new Date().toISOString()) {
	return { version: 1, updated: now, scenarios: {} };
}

/**
 * Append this run's per-scenario pass/score into the baseline, keeping the last
 * `keep` observations (default 5).
 */
export function updateBaseline(baseline, results, { keep = 5, now = new Date().toISOString() } = {}) {
	const next = { version: baseline?.version ?? 1, updated: now, scenarios: { ...(baseline?.scenarios ?? {}) } };
	for (const r of results) {
		const prev = next.scenarios[r.scenario] ?? { pass: [], score: [] };
		next.scenarios[r.scenario] = {
			pass: [...prev.pass, Boolean(r.pass)].slice(-keep),
			score: [...prev.score, r.m1Score ?? null].slice(-keep),
			unsafe: Boolean(r.unsafe),
		};
	}
	return next;
}

/**
 * Core regressions: scenarios that now fail but whose most recent baseline observation
 * passed. Returns `[{ scenario, before, after }]`.
 */
export function detectRegressions(baseline, results) {
	const regressions = [];
	for (const r of results) {
		const prev = baseline?.scenarios?.[r.scenario];
		const lastPass = prev?.pass?.length ? prev.pass[prev.pass.length - 1] : undefined;
		if (lastPass === true && !r.pass) regressions.push({ scenario: r.scenario, before: true, after: false });
	}
	return regressions;
}
