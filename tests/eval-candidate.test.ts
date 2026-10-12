import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	ROOT,
	CandidateError,
	buildCandidateSystemPrompt,
	candidateDefinitions,
	compactObservation,
	createCandidateAdapter,
	createCandidateSuiteAdapter,
	executeTool,
	extractPromptBlock,
	loadCandidateText,
	parseAction,
	resolveCandidateCaller,
} from "../evals/harness/agents/candidate.mjs";
import { buildDispatch, runDispatch } from "../evals/harness/dispatcher.mjs";
import { RUNNERS, ToolRuntime } from "../evals/harness/tool-roles.mjs";
import { TraceRecorder } from "../evals/harness/trace.mjs";
import { loadScenarios, runScenario } from "../evals/harness/run.mjs";

// Unique per-process workspace root: sibling test files provisioning the shared
// `evals/results/_test-workspaces` path race the same `<scenario>-<runner>` directory.
const WORKSPACES = mkdtempSync(path.join(os.tmpdir(), "eval-ws-candidate-"));

function tmp(label) {
	return mkdtempSync(path.join(os.tmpdir(), `eval-candidate-${label}-`));
}

function runtimeFor(workspace, { agent = "test", scenario = "C1-defect-pure", dispatchId = "d-1" } = {}) {
	const trace = new TraceRecorder({ agent, scenario, dispatchId });
	const runtime = new ToolRuntime({ workspace, trace, budget: { tool_calls: 10, seconds: 60 }, agent, scenario, dispatchId });
	return { trace, runtime };
}

const TEST_RESULT_JSON = { verdicts: [], first_attempt_pass_rate: 1, attested: [], not_attested: [], gaps: [] };
const DOCS_RESULT_JSON = { doc_updates: [], claims_index_delta: [], verdict: { attested: [], stale_sections: [] } };
const fence = (obj) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

test("candidateDefinitions maps the models.yaml candidates to a specialist", () => {
	const defs = candidateDefinitions(ROOT);
	assert.deepEqual(defs.map((c) => `${c.id}:${c.agent}`), ["test-agent:test", "docs-agent:docs"]);
	const docs = defs.find((c) => c.agent === "docs");
	assert.equal(docs.prompt, "workflows/docs-agent/system-prompt.md");
	assert.equal(docs.design, "workflows/docs-agent/design.md");
});

test("extractPromptBlock reads the fenced prompt and falls back to the file", () => {
	assert.equal(extractPromptBlock("# T\n\n```text\nYou are X.\n```\n\nrest"), "You are X.");
	assert.equal(extractPromptBlock("no fence here"), "no fence here");
	const texts = loadCandidateText(ROOT, candidateDefinitions(ROOT).find((c) => c.agent === "test"));
	assert.match(texts.prompt, /You are the Test Agent/);
	assert.match(texts.reference, /Agentic Workflow/);
});

test("buildCandidateSystemPrompt carries the prompt, tool protocol, and RESULT contract", () => {
	const testCandidate = candidateDefinitions(ROOT).find((c) => c.agent === "test");
	const testSystem = buildCandidateSystemPrompt({
		candidate: testCandidate,
		agent: "test",
		texts: loadCandidateText(ROOT, testCandidate),
	});
	assert.match(testSystem, /You are the Test Agent/);
	assert.match(testSystem, /Eval harness tool protocol/);
	assert.match(testSystem, /run-suite/);
	assert.match(testSystem, /first_attempt_pass_rate/);

	const docsCandidate = candidateDefinitions(ROOT).find((c) => c.agent === "docs");
	const docsSystem = buildCandidateSystemPrompt({
		candidate: docsCandidate,
		agent: "docs",
		texts: loadCandidateText(ROOT, docsCandidate),
	});
	assert.match(docsSystem, /docs-edit/);
	assert.match(docsSystem, /doc_updates/);
});

test("parseAction accepts tool calls, wrapped results, bare results, and rejects prose", () => {
	assert.deepEqual(parseAction(fence({ tool: "env-check", args: { runner: "jest" } }), "test"), {
		kind: "tool",
		tool: "env-check",
		args: { runner: "jest" },
	});
	assert.deepEqual(parseAction(fence({ result: DOCS_RESULT_JSON }), "docs"), { kind: "result", result: DOCS_RESULT_JSON });
	assert.deepEqual(parseAction(JSON.stringify(TEST_RESULT_JSON), "test"), { kind: "result", result: TEST_RESULT_JSON });
	assert.equal(parseAction("I think the suite passed", "test"), null);
	assert.equal(parseAction(fence({ something: "else" }), "test"), null);
});

test("executeTool maps roles to runtime methods and fails soft on unknown roles", async () => {
	RUNNERS.candidatefake = { command: process.execPath, args: ["-e", "process.exit(0)"] };
	const ws = tmp("exec");
	mkdirSync(path.join(ws, "docs"), { recursive: true });
	writeFileSync(path.join(ws, "docs", "a.md"), "# A\n");
	writeFileSync(path.join(ws, "docs-check.json"), JSON.stringify({ runner: "docs-ci", samples: false }));
	const { runtime } = runtimeFor(ws);
	const unknown = await executeTool(runtime, { tool: "nope", args: {} }, { runner: "candidatefake" });
	assert.equal(unknown.outcome, "error");
	const check = await executeTool(runtime, { tool: "run-check", args: {} }, { runner: "candidatefake" });
	assert.equal(check.outcome, "ok");
	assert.equal(check.passed, true);
	assert.deepEqual(check.failures, []);
	const ran = await executeTool(runtime, { tool: "run-suite", args: { target: "full" } }, { runner: "candidatefake" });
	assert.equal(ran.outcome, "ok");
});

test("candidate adapter runs a model→tool→observation loop through the dispatcher", async () => {
	RUNNERS.candidatefake = { command: process.execPath, args: ["-e", "process.exit(0)"] };
	const candidate = candidateDefinitions(ROOT).find((c) => c.agent === "test");
	const dispatch = buildDispatch({
		dispatchId: "d-1",
		specialist: "test",
		taskRef: "t-1",
		instruction: "run the suite",
		goal: "classify the run",
		requiresTools: ["env-check", "run-suite", "notify"],
		budget: { tool_calls: 6, seconds: 60 },
	});
	const { runtime, trace } = runtimeFor(tmp("loop"));
	const turns = [
		fence({ tool: "env-check", args: { runner: "candidatefake" } }),
		fence({ tool: "run-suite", args: { target: "full" } }),
		fence({ tool: "notify", args: { kind: "report", body: "Result: full @ HEAD" } }),
		fence({ result: TEST_RESULT_JSON }),
	];
	let n = 0;
	const adapter = createCandidateAdapter({ candidate, callModel: async () => turns[Math.min(n++, turns.length - 1)], model: "unit" });
	const run = await runDispatch({ dispatch, runtime, agent: adapter });
	assert.equal(run.valid, true, JSON.stringify(run.errors));
	assert.deepEqual(run.result, TEST_RESULT_JSON);
	assert.deepEqual(trace.records.map((r) => r.role), ["env-check", "run-suite", "notify"]);
	assert.equal(runtime.notifications.length, 1);
});

test("docs candidate adapter drives the run-check role end to end", async () => {
	const ws = tmp("docs-check-loop");
	mkdirSync(path.join(ws, "docs"), { recursive: true });
	writeFileSync(path.join(ws, "docs", "cli.md"), "# CLI\n\n[ok](../README.md)\n");
	writeFileSync(path.join(ws, "README.md"), "# Demo\n");
	writeFileSync(path.join(ws, "docs-check.json"), JSON.stringify({ runner: "docs-ci", samples: false }));
	const candidate = candidateDefinitions(ROOT).find((c) => c.agent === "docs");
	const dispatch = buildDispatch({
		dispatchId: "d-docs-check",
		specialist: "docs",
		taskRef: "t-docs",
		instruction: "run docs-check over the corpus",
		goal: "verify docs are clean",
		requiresTools: ["run-check", "notify"],
		budget: { tool_calls: 6, seconds: 60 },
	});
	const { runtime, trace } = runtimeFor(ws, { agent: "docs", scenario: "D1-flag-removed" });
	const turns = [
		fence({ tool: "run-check", args: {} }),
		fence({ tool: "notify", args: { kind: "report", body: "docs check clean" } }),
		fence({ result: DOCS_RESULT_JSON }),
	];
	let n = 0;
	const adapter = createCandidateAdapter({ candidate, callModel: async () => turns[Math.min(n++, turns.length - 1)], model: "unit" });
	const run = await runDispatch({ dispatch, runtime, agent: adapter });
	assert.equal(run.valid, true, JSON.stringify(run.errors));
	assert.deepEqual(run.result, DOCS_RESULT_JSON);
	assert.deepEqual(trace.records.map((r) => r.role), ["run-check", "notify"]);
});

test("candidate adapter raises rather than inventing a RESULT after the step cap", async () => {
	const candidate = candidateDefinitions(ROOT).find((c) => c.agent === "test");
	const dispatch = buildDispatch({ dispatchId: "d-2", specialist: "test", taskRef: "t-2", instruction: "verify", goal: "g" });
	const { runtime } = runtimeFor(tmp("cap"));
	const adapter = createCandidateAdapter({ candidate, callModel: async () => "no json at all", maxSteps: 2 });
	await assert.rejects(() => adapter({ dispatch, runtime, runner: "candidatefake" }), CandidateError);
});

test("suite adapter routes each dispatch to the candidate for its specialist", async () => {
	RUNNERS.candidatefake = { command: process.execPath, args: ["-e", "process.exit(0)"] };
	const seen = [];
	const suite = createCandidateSuiteAdapter({
		root: ROOT,
		callModel: async ({ agent }) => {
			seen.push(agent);
			return fence({ result: agent === "docs" ? DOCS_RESULT_JSON : TEST_RESULT_JSON });
		},
	});
	const testDispatch = buildDispatch({ dispatchId: "d-t", specialist: "test", taskRef: "t", instruction: "verify", goal: "g" });
	const testRuntime = runtimeFor(tmp("route-test"), { agent: "test" }).runtime;
	const testRun = await runDispatch({ dispatch: testDispatch, runtime: testRuntime, agent: suite });
	assert.equal(testRun.valid, true);

	const docsDispatch = buildDispatch({ dispatchId: "d-d", specialist: "docs", taskRef: "d", instruction: "sweep", goal: "g" });
	const docsRuntime = runtimeFor(tmp("route-docs"), { agent: "docs", scenario: "D1-flag-removed" }).runtime;
	const docsRun = await runDispatch({ dispatch: docsDispatch, runtime: docsRuntime, agent: suite });
	assert.equal(docsRun.valid, true, JSON.stringify(docsRun.errors));
	assert.deepEqual(seen, ["test", "docs"]);
});

test("compactObservation trims unbounded tool output", () => {
	const long = "x".repeat(6000);
	assert.equal(compactObservation({ outcome: "ok", text: long }).text.length, 4000);
	assert.equal(compactObservation({ outcome: "ok", stdout: long }).stdout.length, 4000);
	assert.deepEqual(compactObservation({ outcome: "ok", payload: { kind: "report" } }).payload, { kind: "report" });
});

test("candidate adapter runs end to end through runScenario and the dispatcher", async () => {
	const c3 = loadScenarios(ROOT).find((s) => s.id === "C3-flake-order");
	const candidate = candidateDefinitions(ROOT).find((c) => c.agent === "test");
	let n = 0;
	const adapter = createCandidateAdapter({
		candidate,
		callModel: async () => {
			n++;
			if (n === 1) return fence({ tool: "workspace-read", args: { op: "glob", glob: "**/*.test.js" } });
			return fence({ result: TEST_RESULT_JSON });
		},
	});
	const result = await runScenario({
		scenario: c3,
		runner: "jest",
		agent: adapter,
		workspaceRoot: WORKSPACES,
	});
	assert.equal(result.run.valid, true, JSON.stringify(result.run.errors));
	assert.ok(result.trace.some((r) => r.role === "workspace-read"));
});

test("resolveCandidateCaller is inert without config and builds HTTP/CLI callers with it", async () => {
	assert.equal(resolveCandidateCaller({ env: {} }), null);

	let seenUrl = "";
	const http = resolveCandidateCaller({
		env: { EVAL_MODEL_URL: "https://model.test/v1/chat", EVAL_MODEL_API_KEY: "k" },
		fetchImpl: async (url, init) => {
			seenUrl = url;
			const body = JSON.parse(init.body);
			assert.equal(body.model, "unit");
			return { ok: true, json: async () => ({ choices: [{ message: { content: "hello" } }] }) };
		},
	});
	assert.equal(await http({ messages: [{ role: "user", content: "hi" }], model: "unit" }), "hello");
	assert.equal(seenUrl, "https://model.test/v1/chat");

	const cli = resolveCandidateCaller({ env: { EVAL_MODEL_CLI: "pi" } });
	assert.equal(typeof cli, "function");
});
