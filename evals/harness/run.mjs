#!/usr/bin/env node
// Eval runner CLI (spec: workflows/test-eval-spec.md §6).
//
//   npm run eval:core   -> the core catalog (both runners where present)
//   npm run eval:full   -> the full catalog (+ judge when EVAL_JUDGE_URL is set)
//   node evals/harness/run.mjs one C3-flake-order
//
// The runner provisions a fresh workspace per scenario, builds the DISPATCH, drives the
// candidate agent through the tool roles with a trace recorder, validates the RESULT, and
// scores it mechanically. Result lines land in evals/results/<date>/<model>.jsonl; the
// committed baseline is only rewritten with --update-baseline.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadYamlFile } from "./config.mjs";
import { buildScenarioDispatch, runDispatch } from "./dispatcher.mjs";
import { TraceRecorder } from "./trace.mjs";
import { ToolRuntime, provisionWorkspace } from "./tool-roles.mjs";
import { scoreRun } from "../scorer/mechanical.mjs";
import { aggregateSuite, detectRegressions, toResultLine, updateBaseline } from "../scorer/aggregate.mjs";
import { resolveJudgeCaller, runJudge } from "../judge/judge.mjs";

export const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const SCENARIOS_FILE = path.join(ROOT, "evals/config/scenarios.yaml");

/** Load the catalog and fold `defaults` into each scenario's dispatch block. */
export function loadScenarios(root = ROOT) {
	const config = loadYamlFile(path.join(root, "evals/config/scenarios.yaml"));
	const defaults = config.defaults ?? {};
	return (config.scenarios ?? []).map((s) => ({
		...s,
		dispatch: {
			requires_tools: defaults.requires_tools,
			budget: defaults.budget,
			...s.dispatch,
		},
	}));
}

/** Select scenarios for a mode: `core`, `full`, or `one <id>`. */
export function selectScenarios(scenarios, mode, id) {
	if (mode === "full") return scenarios;
	if (mode === "core") return scenarios.filter((s) => s.core === true);
	if (mode === "one") return scenarios.filter((s) => s.id === id);
	throw new Error(`unknown eval mode: ${mode}`);
}

/** Fixture dir for a runner binding, falling back to the first declared runner. */
export function fixtureFor(scenario, runner) {
	const fixtures = scenario.fixtures ?? {};
	if (runner && fixtures[runner]) return fixtures[runner];
	return Object.values(fixtures)[0];
}

/** Runners whose fixture dir exists in this checkout. */
export function availableRunners(scenario, root = ROOT) {
	return Object.entries(scenario.fixtures ?? {})
		.filter(([, f]) => existsSync(path.resolve(root, f)))
		.map(([r]) => r);
}

/** A scenario is runnable when at least one declared fixture dir exists in this checkout. */
export function scenarioPresent(scenario, root = ROOT) {
	return availableRunners(scenario, root).length > 0;
}

function loadFixtureManifest(workspace) {
	const file = path.join(workspace, "fixture.json");
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

/**
 * Run one scenario through the candidate agent and score it. Returns the score, the
 * dispatch result, the trace records, and the provisioned workspace.
 */
export async function runScenario({
	scenario,
	runner,
	agent,
	root = ROOT,
	workspaceRoot = path.join(ROOT, "evals/results/_workspaces"),
}) {
	const fixtureRel = fixtureFor(scenario, runner);
	if (!fixtureRel) throw new Error(`${scenario.id}: no fixture for runner ${runner}`);
	const fixtureDir = path.resolve(root, fixtureRel);
	const workspace = provisionWorkspace(fixtureDir, path.join(workspaceRoot, `${scenario.id}-${runner}`));
	const dispatch = buildScenarioDispatch(scenario, {
		dispatchId: `d-${scenario.id}`,
		taskRef: `eval-${scenario.id}`,
	});
	const trace = new TraceRecorder({ agent: scenario.agent, scenario: scenario.id, dispatchId: dispatch.dispatch_id });
	const runtime = new ToolRuntime({
		workspace,
		trace,
		budget: dispatch.budget,
		agent: scenario.agent,
		scenario: scenario.id,
		dispatchId: dispatch.dispatch_id,
	});
	const run = await runDispatch({
		dispatch,
		runtime,
		retryFresh: scenario.retry_fresh === true,
		agent: (ctx) => agent({ ...ctx, runner, scenario }),
	});
	const manifest = {
		...(loadFixtureManifest(workspace) ?? {}),
		...(scenario.manifest_hints ?? {}),
		citations_root: workspace,
	};
	const score = scoreRun({ scenario, ...run, trace: trace.records, manifest });
	return { scenario, runner, score, run, trace: trace.records, workspace, manifest };
}

/**
 * Run a mode end to end. `agent` is the candidate adapter `({dispatch, runtime, runner,
 * scenario}) => RESULT`. Writes result JSONL when `writeResults` is true. Never mutates
 * the committed baseline unless `updateBaseline` is true.
 */
export async function runEval({
	mode = "core",
	id,
	agent,
	runner,
	model = "smoke",
	candidate = "smoke",
	root = ROOT,
	workspaceRoot,
	resultsDir = path.join(ROOT, "evals/results"),
	baselineFile = path.join(ROOT, "evals/baselines/current.json"),
	writeResults = true,
	updateBaseline: writeBaseline = false,
	now = new Date(),
	callModel,
} = {}) {
	if (typeof agent !== "function") throw new Error("runEval requires an agent adapter");
	const scenarios = selectScenarios(loadScenarios(root), mode, id);
	const ran = [];
	const skipped = [];
	const errors = [];
	for (const scenario of scenarios) {
		if (!scenarioPresent(scenario, root)) {
			skipped.push({ id: scenario.id, reason: "fixture(s) not present" });
			continue;
		}
		const runners = availableRunners(scenario, root);
		const chosen = runner && runners.includes(runner) ? runner : runners[0];
		try {
			const result = await runScenario({ scenario, runner: chosen, agent, root, workspaceRoot });
			if (scenario.control) {
				const controlScenario = selectScenarios(loadScenarios(root), "one", scenario.control)[0];
				if (controlScenario && scenarioPresent(controlScenario, root)) {
					const control = await runScenario({ scenario: controlScenario, runner: chosen, agent, root, workspaceRoot });
					result.score = scoreRun({
						scenario,
						...result.run,
						trace: result.trace,
						manifest: result.manifest,
						control: { result: control.run.result },
					});
				}
			}
			ran.push(result);
		} catch (err) {
			errors.push({ id: scenario.id, error: err.message });
		}
	}

	// judge (full mode only, when a caller is configured/injected) — tracked, never gating
	if (callModel || (mode === "full" && resolveJudgeCaller())) {
		const caller = callModel ?? resolveJudgeCaller();
		for (const r of ran) {
			const reportText = JSON.stringify(r.run.notifications ?? []);
			try {
				r.judge = await runJudge({ reportText, manifestContext: r.scenario, agent: r.scenario.agent, callModel: caller, model });
			} catch (err) {
				r.judge = { error: err.message };
			}
		}
	}

	const summary = aggregateSuite(ran.map((r) => r.score));
	const baseline = JSON.parse(JSON.stringify({ version: 1, updated: now.toISOString(), scenarios: {} }));
	if (existsSync(baselineFile)) {
		try {
			Object.assign(baseline, JSON.parse(readFileSync(baselineFile, "utf8")));
		} catch {
			/* keep empty baseline */
		}
	}
	const regressions = detectRegressions(baseline, ran.map((r) => r.score));
	if (writeResults && ran.length > 0) {
		const date = now.toISOString().slice(0, 10);
		const dir = path.join(resultsDir, date);
		mkdirSync(dir, { recursive: true });
		const lines = ran.map((r) => JSON.stringify(toResultLine(r.score, { candidate, model, judge: r.judge, seconds: r.run.seconds, tokens: r.run.tokens })));
		writeFileSync(path.join(dir, `${model}.jsonl`), `${lines.join("\n")}\n`);
		for (const r of ran) {
			const traceLines = r.trace.map((x) => JSON.stringify(x)).join("\n");
			writeFileSync(path.join(dir, `${model}.${r.scenario.id}.trace.jsonl`), traceLines ? `${traceLines}\n` : "");
		}
	}
	if (writeBaseline) {
		const next = updateBaseline(baseline, ran.map((r) => r.score), { now: now.toISOString() });
		writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
	}
	return { summary, regressions, results: ran, skipped, errors };
}

async function main(argv = process.argv.slice(2)) {
	const mode = argv[0] ?? "core";
	const flag = (name, fallback) => {
		const i = argv.indexOf(`--${name}`);
		return i === -1 ? fallback : argv[i + 1];
	};
	const id = mode === "one" ? argv[1] : undefined;
	let agent = (await import("./agents/smoke.mjs")).run;
	const agentPath = flag("agent");
	if (agentPath) {
		const mod = await import(pathToFileURL(path.resolve(agentPath)).href);
		agent = mod.default ?? mod.run;
	}
	const result = await runEval({
		mode: id ? "one" : mode,
		id,
		agent,
		runner: flag("runner"),
		model: flag("model", "smoke"),
		candidate: flag("candidate", agentPath ? path.basename(agentPath) : "smoke"),
		workspaceRoot: flag("workspaces", path.join(os.tmpdir(), "eval-workspaces")),
		writeResults: !argv.includes("--no-results"),
		updateBaseline: argv.includes("--update-baseline"),
	});
	const { summary } = result;
	console.log(`eval:${mode} — ${summary.passes}/${summary.total} scenarios pass (${(summary.passRate * 100).toFixed(0)}%)`);
	console.log(`  M1 mean ${summary.m1Mean ?? "n/a"} | safety violations ${summary.safetyViolations.length}`);
	if (result.skipped.length) console.log(`  skipped (fixtures pending): ${result.skipped.map((s) => s.id).join(", ")}`);
	if (result.regressions.length) console.log(`  REGRESSIONS: ${result.regressions.map((r) => r.scenario).join(", ")}`);
	if (result.errors.length) console.log(`  errors: ${result.errors.map((e) => `${e.id}: ${e.error}`).join("; ")}`);
	const threshold = mode === "full" ? 0.85 : 1;
	const belowThreshold = summary.total > 0 && summary.passRate < threshold;
	return summary.safetyViolations.length > 0 || result.regressions.length > 0 || belowThreshold ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((code) => process.exit(code));
}
