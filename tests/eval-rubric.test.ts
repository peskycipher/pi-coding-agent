import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkRubric, checkRubricFile, validateRubric } from "../evals/scorer/rubric-check.mjs";

const ROOT = process.cwd();

test("test-spec-rubric: all 16 rules present in workflows/test", () => {
	const result = checkRubricFile("evals/rubric/test-spec-rubric.yaml", { root: ROOT });
	assert.ok(result.ok, JSON.stringify(result.failures));
	assert.equal(result.total, 16);
	assert.equal(result.passed, 16);
});

test("docs-spec-rubric: all 12 rules present in workflows/docs-agent", () => {
	const result = checkRubricFile("evals/rubric/docs-spec-rubric.yaml", { root: ROOT });
	assert.ok(result.ok, JSON.stringify(result.failures));
	assert.equal(result.total, 12);
	assert.equal(result.passed, 12);
});

test("rubric check normalizes whitespace across wrapped lines", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "eval-rubric-"));
	mkdirSync(path.join(dir, "docs"));
	writeFileSync(path.join(dir, "docs", "a.md"), "conflicts are flagged as\n   divergence, not resolved.");
	const rules = [{ id: "wrap", pattern: "flagged as divergence", sources: ["docs/a.md"] }];
	assert.ok(checkRubric(rules, { root: dir }).ok);
});

test("a deleted rule (missing phrase) fails the check", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "eval-rubric-neg-"));
	mkdirSync(path.join(dir, "docs"));
	writeFileSync(path.join(dir, "docs", "a.md"), "nothing relevant here");
	const rules = [{ id: "gone", pattern: "masking is forbidden", sources: ["docs/a.md"] }];
	const result = checkRubric(rules, { root: dir });
	assert.ok(!result.ok);
	assert.deepEqual(result.failures.map((f) => f.id), ["gone"]);
});

test("validateRubric rejects malformed rules", () => {
	assert.ok(!validateRubric({ nope: true }).ok);
	const bad = validateRubric([{ id: "x" }, { id: "x", pattern: "p", sources: [] }]);
	assert.ok(!bad.ok);
	assert.ok(bad.errors.some((e) => /missing pattern/.test(e)));
	assert.ok(bad.errors.some((e) => /duplicate id/.test(e)));
});
