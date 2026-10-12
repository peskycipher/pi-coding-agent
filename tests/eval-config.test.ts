import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadYamlFile } from "../evals/harness/config.mjs";
import { buildScenarioDispatch } from "../evals/harness/dispatcher.mjs";
import {
	ROOT,
	availableRunners,
	loadScenarios,
	runEval,
	runScenario,
	scenarioPresent,
	selectScenarios,
} from "../evals/harness/run.mjs";
import { runRubricChecks } from "../evals/scorer/rubric-cli.mjs";
import { TraceRecorder } from "../evals/harness/trace.mjs";

const CORE = [
	"C1-defect-pure",
	"C2-defect-flake-mix",
	"C5-env-gap",
	"C6-retry-evidence",
	"C7-inject-output",
	"C9-green-on-first",
	"C10-identical-twice",
	"D1-flag-removed",
	"D2-healthy-control",
	"D6-release-notes",
	"D8-quarantine-record",
];

const PASS_RESULT = { verdicts: [], first_attempt_pass_rate: 1, attested: [], not_attested: [], gaps: [] };

test("scenarios.yaml is a valid catalog with stable IDs and the spec core set", () => {
	const scenarios = loadScenarios(ROOT);
	assert.equal(scenarios.length, 26);
	for (const s of scenarios) {
		assert.match(s.id, /^[A-Z][0-9]+-[a-z0-9-]+$/, `bad id ${s.id}`);
		assert.ok(["test", "docs"].includes(s.agent));
		assert.ok(s.fixtures && Object.keys(s.fixtures).length > 0, `${s.id} has no fixtures`);
		assert.ok(Array.isArray(s.dispatch.requires_tools), `${s.id} missing defaults`);
		assert.ok(s.dispatch.budget.tool_calls > 0);
	}
	const core = selectScenarios(scenarios, "core").map((s) => s.id);
	assert.deepEqual(core, CORE);
});

test("every scenario builds a schema-valid DISPATCH", () => {
	for (const s of loadScenarios(ROOT)) {
		assert.doesNotThrow(() => buildScenarioDispatch(s, { dispatchId: "d-x", taskRef: "t-x" }), s.id);
	}
});

test("fixture presence reflects the committed checkout honestly", () => {
	const scenarios = loadScenarios(ROOT);
	const c3 = scenarios.find((s) => s.id === "C3-flake-order");
	const c2 = scenarios.find((s) => s.id === "C2-defect-flake-mix");
	const c1 = scenarios.find((s) => s.id === "C1-defect-pure");
	assert.ok(scenarioPresent(c3));
	assert.deepEqual(availableRunners(c3).sort(), ["jest", "pytest"]);
	assert.ok(scenarioPresent(c2));
	assert.deepEqual(availableRunners(c2), ["jest"]); // pytest variant is not generated yet
	assert.ok(scenarioPresent(c1));
	assert.deepEqual(availableRunners(c1).sort(), ["jest", "pytest"]);
});

test("selectScenarios modes", () => {
	const scenarios = loadScenarios(ROOT);
	assert.equal(selectScenarios(scenarios, "full").length, scenarios.length);
	assert.equal(selectScenarios(scenarios, "one", "C3-flake-order").length, 1);
	assert.equal(selectScenarios(scenarios, "one", "nope").length, 0);
	assert.throws(() => selectScenarios(scenarios, "bogus"), /unknown eval mode/);
});

test("models.yaml declares the tier matrix and judge config", () => {
	const models = loadYamlFile(path.join(ROOT, "evals/config/models.yaml"));
	assert.ok(models.matrix.cheap && models.matrix.strong);
	assert.equal(models.judge.prompt_version, "judge-prompt-v1");
	assert.equal(models.judge.healthy_mean, 3.5);
});

test("tool-trace schema file is valid JSON with the spec-required fields", () => {
	const schema = JSON.parse(readFileSync(path.join(ROOT, "evals/schemas/tool-trace.schema.json"), "utf8"));
	assert.deepEqual(new Set(schema.required), new Set(["ts", "scenario", "agent", "role", "outcome"]));
	assert.ok(schema.properties.argsDigest.maxLength === 200);
	assert.deepEqual(schema.properties.agent.enum, ["test", "docs"]);
});

test("runScenario provisions a workspace, dispatches, traces, and scores", async () => {
	const c3 = loadScenarios(ROOT).find((s) => s.id === "C3-flake-order");
	const result = await runScenario({
		scenario: c3,
		runner: "jest",
		agent: async () => PASS_RESULT,
		workspaceRoot: path.join(ROOT, "evals/results/_test-workspaces"),
	});
	assert.ok(existsSync(path.join(result.workspace, "state.test.js")));
	assert.equal(result.run.valid, true);
	assert.ok(result.score.checks.length > 0);
	assert.equal(result.score.scenario, "C3-flake-order");
});

test("runEval one-scenario run is dry by default and reports skipped fixtures", async () => {
	const run = await runEval({
		mode: "one",
		id: "C3-flake-order",
		agent: async () => PASS_RESULT,
		writeResults: false,
		updateBaseline: false,
		workspaceRoot: path.join(ROOT, "evals/results/_test-workspaces"),
	});
	assert.equal(run.summary.total, 1);
	assert.equal(run.results.length, 1);
	assert.equal(run.errors.length, 0);
});

test("runEval persists a result line and a schema-valid tool trace", async () => {
	const resultsDir = mkdtempSync(path.join(os.tmpdir(), "eval-results-"));
	const run = await runEval({
		mode: "one",
		id: "C3-flake-order",
		agent: async ({ runtime }) => {
			await runtime.notify({ kind: "report", body: "Result: full @ HEAD" });
			return PASS_RESULT;
		},
		model: "unit",
		writeResults: true,
		updateBaseline: false,
		resultsDir,
		workspaceRoot: path.join(ROOT, "evals/results/_test-workspaces"),
	});
	assert.equal(run.results.length, 1);
	const date = new Date().toISOString().slice(0, 10);
	const resultFile = path.join(resultsDir, date, "unit.jsonl");
	assert.ok(existsSync(resultFile));
	const line = JSON.parse(readFileSync(resultFile, "utf8").trim());
	assert.equal(line.scenario, "C3-flake-order");
	const traceFile = path.join(resultsDir, date, "unit.C3-flake-order.trace.jsonl");
	const records = TraceRecorder.fromJSONL(readFileSync(traceFile, "utf8"));
	assert.ok(records.length >= 1);
	assert.equal(records[0].role, "notify");
});

test("runRubricChecks passes both spec rubrics", () => {
	const result = runRubricChecks(ROOT);
	assert.ok(result.ok, JSON.stringify(result.failures));
	assert.equal(result.totalRules, 28);
	assert.equal(result.passedRules, 28);
});
