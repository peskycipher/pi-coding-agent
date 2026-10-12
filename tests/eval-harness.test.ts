import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TraceRecorder } from "../evals/harness/trace.mjs";
import {
	BudgetExceededError,
	GateRejectedError,
	RUNNERS,
	ToolRuntime,
	globToRegExp,
	isDocsPath,
	isTestPath,
	provisionWorkspace,
	resolveInside,
	unifiedDiff,
} from "../evals/harness/tool-roles.mjs";
import {
	DispatchError,
	buildDispatch,
	buildScenarioDispatch,
	runDispatch,
} from "../evals/harness/dispatcher.mjs";

const SCN = "C1-defect-pure";

function tmp(label) {
	return mkdtempSync(path.join(os.tmpdir(), `eval-${label}-`));
}

function runtimeFor(workspace, { budget } = {}) {
	const trace = new TraceRecorder({ agent: "test", scenario: SCN, dispatchId: "d-1" });
	return { trace, runtime: new ToolRuntime({ workspace, trace, budget }) };
}

const PASS_RESULT = {
	verdicts: [{ testId: "a.test.js::passes", class: "pass", evidence: "a.test.js:1" }],
	first_attempt_pass_rate: 1,
	attested: ["harness"],
	not_attested: [],
	gaps: [],
};

test("isTestPath accepts test code/fixtures and rejects product code", () => {
	assert.ok(isTestPath("tests/foo.test.js"));
	assert.ok(isTestPath("src/foo.test.js"));
	assert.ok(isTestPath("__tests__/a.js"));
	assert.ok(isTestPath("test_a.py"));
	assert.ok(isTestPath("a_test.py"));
	assert.ok(isTestPath("fixtures/a.json"));
	assert.ok(!isTestPath("src/server.js"));
	assert.ok(!isTestPath("../outside.test.js"));
});

test("docs-edit is gated to docs paths only", async () => {
	assert.ok(isDocsPath("docs/api.md"));
	assert.ok(isDocsPath("README.md"));
	assert.ok(!isDocsPath("src/index.ts"));
	const ws = tmp("docsedit");
	const { runtime } = runtimeFor(ws);
	const ok = await runtime.docsEdit({ path: "docs/api.md", content: "# API\n" });
	assert.equal(ok.outcome, "ok");
	await assert.rejects(() => runtime.docsEdit({ path: "src/index.ts", content: "x" }), GateRejectedError);
});

test("resolveInside jails paths to the workspace", () => {
	const root = tmp("jail");
	assert.equal(resolveInside(root, "a/b.txt"), path.join(root, "a/b.txt"));
	assert.throws(() => resolveInside(root, "../escape.txt"), /escapes workspace/);
	assert.throws(() => resolveInside(root, path.resolve("/etc/passwd")), /escapes workspace/);
});

test("globToRegExp supports * and **", () => {
	assert.ok(globToRegExp("**/*.test.js").test("deep/dir/a.test.js"));
	assert.ok(!globToRegExp("**/*.test.js").test("deep/dir/a.js"));
	assert.ok(globToRegExp("*.py").test("a.py"));
	assert.ok(!globToRegExp("*.py").test("a.pyc"));
});

test("unifiedDiff reports added and removed lines", () => {
	const diff = unifiedDiff("a\nb\n", "a\nc\n", { path: "t.test.js" });
	assert.match(diff, /^--- a\/t\.test\.js/m);
	assert.match(diff, /^-b$/m);
	assert.match(diff, /^\+c$/m);
	assert.equal(unifiedDiff("same", "same"), "");
});

test("provisionWorkspace copies a fixture into a fresh tree", () => {
	const src = tmp("src");
	mkdirSync(path.join(src, "tests"));
	writeFileSync(path.join(src, "tests", "a.test.js"), "test('a',()=>{})");
	const dest = path.join(tmp("dest"), "ws");
	provisionWorkspace(src, dest);
	assert.ok(existsSync(path.join(dest, "tests", "a.test.js")));
});

test("run-suite executes a bound runner and traces outcome", async () => {
	RUNNERS.fake = { command: process.execPath, args: ["-e", "process.exit(0)"] };
	const ws = tmp("run");
	const { runtime, trace } = runtimeFor(ws);
	const res = await runtime.runSuite({ runner: "fake", target: "full" });
	assert.equal(res.outcome, "ok");
	assert.equal(trace.records.length, 1);
	assert.equal(trace.records[0].role, "run-suite");
	assert.equal(trace.records[0].outcome, "ok");
});

test("run-suite records a failing runner as outcome error without throwing", async () => {
	RUNNERS.fakefail = { command: process.execPath, args: ["-e", "process.exit(3)"] };
	const ws = tmp("runfail");
	const { runtime } = runtimeFor(ws);
	const res = await runtime.runSuite({ runner: "fakefail", target: "full" });
	assert.equal(res.outcome, "error");
	assert.equal(res.exitCode, 3);
});

test("test-edit writes test code and returns the S-gate diff; refuses product code", async () => {
	const ws = tmp("edit");
	const { runtime, trace } = runtimeFor(ws);
	const ok = await runtime.testEdit({ path: "tests/a.test.js", content: "test('a',()=>{expect(1).toBe(1)})" });
	assert.equal(ok.outcome, "ok");
	assert.ok(existsSync(path.join(ws, "tests", "a.test.js")));
	assert.match(ok.diff, /\+test\('a'/);
	await assert.rejects(
		() => runtime.testEdit({ path: "src/server.js", content: "// weakened" }),
		GateRejectedError,
	);
	assert.ok(!existsSync(path.join(ws, "src", "server.js")));
	const refused = trace.records.find((r) => r.role === "test-edit" && r.outcome === "error");
	assert.ok(refused, "refused edit must be traced as an error");
});

test("git-info refuses remote/staging verbs and traces read-only failures", async () => {
	const ws = tmp("git");
	const { runtime } = runtimeFor(ws);
	await assert.rejects(() => runtime.gitInfo({ args: ["push", "origin", "main"] }), GateRejectedError);
	const res = await runtime.gitInfo({ args: ["log", "-1"] });
	assert.equal(res.outcome, "error"); // not a git repo, but a traced read-only failure
});

test("workspace-read glob/grep/read and read-log are path-jailed", async () => {
	const ws = tmp("wsread");
	mkdirSync(path.join(ws, "src"));
	writeFileSync(path.join(ws, "src", "a.js"), "const answer = 42;");
	const { runtime } = runtimeFor(ws);
	const glob = await runtime.workspaceRead({ op: "glob", glob: "**/*.js" });
	assert.deepEqual(glob.files, ["src/a.js"]);
	const grep = await runtime.workspaceRead({ op: "grep", pattern: "answer" });
	assert.match(grep.hits[0], /src\/a\.js:1/);
	const read = await runtime.workspaceRead({ op: "read", path: "src/a.js" });
	assert.match(read.text, /42/);
	const log = await runtime.readLog({ path: "src/a.js", tail: 1 });
	assert.match(log.text, /42/);
	await assert.rejects(() => runtime.readLog({ path: "../../etc/hostname" }), /escapes workspace/);
});

test("env-check reports gaps and notifies the requesting surface", async () => {
	const ws = tmp("env");
	const { runtime, trace } = runtimeFor(ws);
	const good = await runtime.envCheck({ checks: [{ name: "node", command: process.execPath, args: ["--version"] }] });
	assert.equal(good.outcome, "ok");
	const bad = await runtime.envCheck({ checks: [{ name: "missing", command: "definitely-not-a-real-binary-xyz" }] });
	assert.equal(bad.outcome, "error");
	assert.equal(bad.gaps.length, 1);
	await runtime.notify({ kind: "report", body: "run report" });
	assert.equal(runtime.notifications.length, 1);
	assert.equal(trace.records.at(-1).role, "notify");
});

test("run-check runs the repo-configured docs CI and returns a structured pass/fail", async () => {
	const ws = tmp("docs-check");
	mkdirSync(path.join(ws, "docs"), { recursive: true });
	writeFileSync(path.join(ws, "docs", "a.md"), "# A\n\n[ok](./b.md)\n[bad](./missing.md)\n");
	writeFileSync(path.join(ws, "docs", "b.md"), "# B\n");
	writeFileSync(path.join(ws, "docs-check.json"), JSON.stringify({ runner: "docs-ci", samples: false }));
	const { runtime, trace } = runtimeFor(ws);
	const res = await runtime.runCheck();
	assert.equal(res.outcome, "error");
	assert.equal(res.passed, false);
	assert.equal(res.source, "docs-check.json");
	assert.equal(res.exitCode, 1);
	assert.ok(res.failures.some((f) => f.includes("missing.md")), JSON.stringify(res.failures));
	assert.equal(trace.records.at(-1).role, "run-check");
	assert.equal(trace.records.at(-1).outcome, "error");
	assert.equal(runtime.consumed, 1);
});

test("run-check executes an allow-listed repo command and parses its JSON report", async () => {
	const ws = tmp("docs-check-cmd");
	const report = JSON.stringify({ checks: [{ name: "link", passed: false, detail: "dead" }] });
	writeFileSync(
		path.join(ws, "docs-check.json"),
		JSON.stringify({ command: "node", args: ["-e", `console.log(JSON.stringify(${report}))`] }),
	);
	const { runtime } = runtimeFor(ws);
	const res = await runtime.runCheck();
	assert.equal(res.outcome, "error");
	assert.equal(res.passed, false);
	assert.deepEqual(res.checks, [{ name: "link", passed: false, detail: "dead" }]);
	assert.equal(res.source, "docs-check.json");
});

test("run-check refuses non-allow-listed commands and escaping paths (path jail)", async () => {
	const ws = tmp("docs-check-gate");
	writeFileSync(path.join(ws, "docs-check.json"), JSON.stringify({ command: "rm", args: ["-rf", "/"] }));
	const { runtime } = runtimeFor(ws);
	await assert.rejects(() => runtime.runCheck(), /not allow-listed/);
	writeFileSync(path.join(ws, "docs-check.json"), JSON.stringify({ command: "node", args: ["../../escape.js"] }));
	await assert.rejects(() => runtime.runCheck(), /escapes workspace/);
});

test("tool-call budget is enforced and the overrun is traced", async () => {
	RUNNERS.fake = { command: process.execPath, args: ["-e", "process.exit(0)"] };
	const ws = tmp("budget");
	const { runtime, trace } = runtimeFor(ws, { budget: { tool_calls: 1, seconds: 300 } });
	await runtime.runSuite({ runner: "fake", target: "full" });
	await assert.rejects(() => runtime.runSuite({ runner: "fake", target: "full" }), BudgetExceededError);
	assert.equal(runtime.consumed, 1);
	assert.equal(trace.records.length, 2);
	assert.equal(trace.records[1].outcome, "error");
});

test("buildDispatch validates the DISPATCH contract; buildScenarioDispatch bridges config", () => {
	const d = buildDispatch({
		dispatchId: "d-1",
		specialist: "test",
		taskRef: "t-1",
		instruction: "verify",
		goal: "verify the change",
		requiresTools: ["run-suite", "env-check"],
	});
	assert.equal(d.reply_expected, "RESULT");
	assert.deepEqual(d.input.constraints, []);
	assert.throws(() => buildDispatch({ dispatchId: "d-2", specialist: "test", taskRef: "t", instruction: "", goal: "g" }), DispatchError);
	const scenario = {
		id: "C1-defect-pure",
		agent: "test",
		instruction: "run the suite",
		dispatch: { goal: "g", requires_tools: ["run-suite"], budget: { tool_calls: 4, seconds: 60 } },
	};
	const sd = buildScenarioDispatch(scenario, { dispatchId: "d-9", taskRef: "t-9" });
	assert.equal(sd.specialist, "test");
	assert.equal(sd.budget.tool_calls, 4);
	assert.equal(sd.task_ref, "t-9");
});

test("runDispatch validates RESULT and re-dispatches once with retry: fresh", async () => {
	const dispatch = buildDispatch({
		dispatchId: "d-1",
		specialist: "test",
		taskRef: "t-1",
		instruction: "verify",
		goal: "g",
	});
	const ws = tmp("dispatch");
	const { runtime } = runtimeFor(ws);
	const valid = await runDispatch({ dispatch, runtime, agent: () => PASS_RESULT });
	assert.ok(valid.valid);
	assert.equal(valid.attempts.length, 1);

	const retried = await runDispatch({ dispatch, runtime, retryFresh: true, agent: ({ attempt }) => (attempt === 0 ? { bogus: true } : PASS_RESULT) });
	assert.ok(retried.valid);
	assert.equal(retried.attempts.length, 2);
	assert.equal(retried.attempts[1].dispatch.input.retry, "fresh");

	const invalid = await runDispatch({ dispatch, runtime, agent: () => ({ bogus: true }) });
	assert.equal(invalid.valid, false);
	assert.equal(invalid.attempts.length, 1);
	assert.ok(invalid.errors.length > 0);
});
