import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DOCS_DIMENSIONS,
	JUDGE_PROMPT_VERSION,
	SYSTEM_PROMPT,
	TEST_DIMENSIONS,
	buildJudgeMessages,
	parseScore,
	resolveJudgeCaller,
	runJudge,
} from "../evals/judge/judge.mjs";

test("judge prompt loads its versioned system block", () => {
	assert.match(SYSTEM_PROMPT, /SCORE:/);
	assert.equal(JUDGE_PROMPT_VERSION, "judge-prompt-v1");
	assert.deepEqual(TEST_DIMENSIONS, ["report_actionability", "verdict_precision"]);
	assert.equal(DOCS_DIMENSIONS.length, 3);
});

test("rotation swaps the report and context blocks", () => {
	const a = buildJudgeMessages({ dimension: "report_actionability", reportText: "REPORT", manifestContext: { x: 1 }, rotation: 0 });
	const b = buildJudgeMessages({ dimension: "report_actionability", reportText: "REPORT", manifestContext: { x: 1 }, rotation: 1 });
	assert.ok(a[1].content.indexOf("[RUN REPORT]") < a[1].content.indexOf("[SCENARIO CONTEXT]"));
	assert.ok(b[1].content.indexOf("[SCENARIO CONTEXT]") < b[1].content.indexOf("[RUN REPORT]"));
	assert.equal(a[0].content, b[0].content);
});

test("parseScore reads SCORE: n and falls back to a bare integer", () => {
	assert.equal(parseScore("SCORE: 4\nREASON: fine"), 4);
	assert.equal(parseScore("I would say 3"), 3);
	assert.equal(parseScore("no number here"), null);
});

test("runJudge double-runs each dimension and tracks a healthy mean", async () => {
	const calls = [];
	const callModel = async ({ dimension, rotation }) => {
		calls.push(`${dimension}:${rotation}`);
		return "SCORE: 4\nREASON: actionable and precise";
	};
	const result = await runJudge({ reportText: "report", manifestContext: { goal: "g" }, callModel });
	assert.equal(result.mean, 4);
	assert.equal(result.healthy, true);
	assert.deepEqual(result.flags, []);
	assert.equal(calls.length, TEST_DIMENSIONS.length * 2);
	assert.equal(result.dimensions.report_actionability.runs.length, 2);
});

test("runJudge flags a dimension when the two runs disagree by more than one point", async () => {
	let n = 0;
	const callModel = async () => (n++ === 0 ? "SCORE: 5" : "SCORE: 1");
	const result = await runJudge({ reportText: "r", callModel, dimensions: ["verdict_precision"] });
	assert.deepEqual(result.flags, ["verdict_precision"]);
	assert.equal(result.dimensions.verdict_precision.flagged, true);
	assert.equal(result.healthy, false);
});

test("runJudge includes the docs register dimension for the docs agent", async () => {
	const result = await runJudge({ reportText: "r", agent: "docs", callModel: async () => "SCORE: 4" });
	assert.ok(result.dimensions.doc_update_register);
});

test("resolveJudgeCaller is inert without an endpoint and configured with one", () => {
	assert.equal(resolveJudgeCaller({ env: {} }), null);
	const caller = resolveJudgeCaller({ env: { EVAL_JUDGE_URL: "https://example.test/v1/chat", EVAL_JUDGE_API_KEY: "k" } });
	assert.equal(typeof caller, "function");
});
