import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	findBrokenInternalLinks,
	parseDocsCheckOutput,
	resolveDocsCheckPlan,
	runDocsCheck,
	runDocsCi,
	runDocsSamples,
	validateDocsCheckPlan,
} from "../shared/docs-check.ts";

function tmp(label) {
	return mkdtempSync(path.join(os.tmpdir(), `docs-check-${label}-`));
}

test("resolveDocsCheckPlan prefers docs-check.json, then package.json, then the binding default", () => {
	const ws = tmp("plan");
	assert.equal(resolveDocsCheckPlan(ws).source, "binding-default");

	writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { "docs:check": "node x.mjs" } }));
	assert.equal(resolveDocsCheckPlan(ws).source, "package.json#scripts.docs:check");
	assert.equal(resolveDocsCheckPlan(ws).command, "npm");

	writeFileSync(path.join(ws, "docs-check.json"), JSON.stringify({ command: "node", args: ["scripts/docs-check.mjs"] }));
	const pinned = resolveDocsCheckPlan(ws);
	assert.equal(pinned.source, "docs-check.json");
	assert.equal(pinned.command, "node");

	writeFileSync(path.join(ws, "docs-check.json"), JSON.stringify({ runner: "docs-ci", samples: false }));
	assert.deepEqual(resolveDocsCheckPlan(ws).kind, "docs-ci");
});

test("validateDocsCheckPlan allow-lists commands and path-jails path-shaped args", () => {
	assert.throws(
		() => validateDocsCheckPlan({ kind: "command", command: "rm", args: ["-rf", "/"], source: "t" }),
		/not allow-listed/,
	);
	const ws = tmp("jail");
	assert.throws(
		() => validateDocsCheckPlan({ kind: "command", command: "node", args: ["../../escape.js"], source: "t" }, ws),
		/escapes workspace/,
	);
	assert.doesNotThrow(() =>
		validateDocsCheckPlan({ kind: "command", command: "node", args: ["--version"], source: "t" }, ws),
	);
});

test("findBrokenInternalLinks resolves file-relative and repo-root-relative targets", () => {
	const ws = tmp("links");
	mkdirSync(path.join(ws, "docs"));
	writeFileSync(path.join(ws, "docs", "index.md"), "# Index\n\n[rel](./guide.md)\n[root](docs/guide.md)\n[ext](https://example.test)\n[cross](README.md)\n");
	writeFileSync(path.join(ws, "docs", "guide.md"), "# Guide\n");
	writeFileSync(path.join(ws, "README.md"), "# Root\n");
	assert.deepEqual(findBrokenInternalLinks(ws), []);

	writeFileSync(path.join(ws, "docs", "broken.md"), "# Broken\n\n[bad](./nope.md)\n");
	const findings = findBrokenInternalLinks(ws);
	assert.equal(findings.length, 1);
	assert.match(findings[0].name, /broken\.md -> \.\/nope\.md/);
	assert.equal(findings[0].passed, false);
});

test("runDocsSamples reports pass/fail per sample and runDocsCi aggregates", () => {
	const ws = tmp("samples");
	mkdirSync(path.join(ws, "samples"));
	writeFileSync(path.join(ws, "samples", "ok.mjs"), "process.exit(0);\n");
	writeFileSync(path.join(ws, "samples", "bad.mjs"), "process.exit(2);\n");
	const samples = runDocsSamples(ws);
	assert.deepEqual(samples.map((s) => s.passed).sort(), [false, true]);
	const report = runDocsCi(ws, { samples: true });
	assert.equal(report.passed, false);
	assert.ok(report.failures.some((f) => f.includes("bad.mjs")));
	assert.equal(runDocsCi(ws, { samples: false }).passed, true);
});

test("parseDocsCheckOutput reads a JSON report and falls back to exit/stderr", () => {
	const report = parseDocsCheckOutput('{"checks":[{"name":"x","pass":false,"detail":"d"}],"failures":["x: d"]}', "", 1);
	assert.deepEqual(report.checks, [{ name: "x", passed: false, detail: "d" }]);
	assert.deepEqual(report.failures, ["x: d"]);

	const fallback = parseDocsCheckOutput("not json", "boom\nmore", 1);
	assert.equal(fallback.checks[0].passed, false);
	assert.ok(fallback.failures.includes("boom"));
	assert.deepEqual(parseDocsCheckOutput("", "", 0).failures, []);
});

test("runDocsCheck returns a structured result for a command plan", () => {
	const ws = tmp("command");
	writeFileSync(
		path.join(ws, "docs-check.json"),
		JSON.stringify({ command: "node", args: ["-e", "process.stdout.write('{\"checks\":[]}')"] }),
	);
	const res = runDocsCheck(ws);
	assert.equal(res.outcome, "ok");
	assert.equal(res.passed, true);
	assert.equal(res.source, "docs-check.json");
});

test("runDocsCheck reports a failing command as an error result without throwing", () => {
	const ws = tmp("failing");
	writeFileSync(path.join(ws, "docs-check.json"), JSON.stringify({ command: "node", args: ["-e", "process.exit(3)"] }));
	const res = runDocsCheck(ws);
	assert.equal(res.outcome, "error");
	assert.equal(res.passed, false);
	assert.equal(res.exitCode, 3);
});
