import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { generate } from "../evals/fixtures/generate.mjs";
import { ROOT, loadScenarios } from "../evals/harness/run.mjs";

// The catalog generator pass covered C1 and C4-C14 plus D1-D10. C2's pytest variant is
// deliberately out of scope (its jest variant is the committed `jest-flake-seed`), so it
// is the one declared fixture that is allowed to be absent.
const KNOWN_MISSING = new Map([
	["evals/fixtures/out/C2-defect-flake-mix-pytest", "C2 pytest variant not generated in the catalog pass"],
]);

// The frozen flake fixtures predate the catalog generator and are scored from
// scenarios.yaml manifest_hints only; they intentionally carry no fixture.json.
const PRESERVED_NO_MANIFEST = new Set([
	"evals/fixtures/out/jest-flake-order",
	"evals/fixtures/out/pytest-flake-order",
	"evals/fixtures/out/jest-flake-seed",
]);

const TEST_CLASSES = new Set(["defect", "flake", "environment", "pass", "coverage_gap"]);
const RISK_CLASSES = new Set(["wrong-instruction", "outdated-reference", "cosmetic"]);

function fixtureDirs() {
	const dirs = new Map();
	for (const s of loadScenarios(ROOT)) {
		for (const rel of Object.values(s.fixtures ?? {})) dirs.set(rel, s);
	}
	return dirs;
}

test("the generator exports generate() and is import-safe", () => {
	assert.equal(typeof generate, "function");
});

test("every declared fixture exists except the documented C2 gap", () => {
	const missing = [];
	for (const [rel, s] of fixtureDirs()) {
		if (KNOWN_MISSING.has(rel)) continue;
		if (!existsSync(path.join(ROOT, rel))) missing.push(`${s.id}: ${rel}`);
	}
	assert.deepEqual(missing, []);
});

test("generated test-agent fixtures carry schema-shaped ground truth manifests", () => {
	const problems = [];
	const seen = new Set();
	for (const [rel, s] of fixtureDirs()) {
		if (s.agent !== "test" || seen.has(rel) || KNOWN_MISSING.has(rel) || PRESERVED_NO_MANIFEST.has(rel)) continue;
		seen.add(rel);
		const file = path.join(ROOT, rel, "fixture.json");
		if (!existsSync(file)) {
			problems.push(`${rel}: missing fixture.json`);
			continue;
		}
		const manifest = JSON.parse(readFileSync(file, "utf8"));
		if (Array.isArray(manifest.tests)) {
			for (const t of manifest.tests) {
				if (typeof t.testId !== "string") problems.push(`${rel}: testId must be a string`);
				if (!TEST_CLASSES.has(t.expectedClass)) problems.push(`${rel}: bad expectedClass ${t.expectedClass}`);
			}
		}
		if (manifest.first_attempt_pass_rate !== undefined) {
			const rate = manifest.first_attempt_pass_rate;
			if (typeof rate !== "number" || rate < 0 || rate > 1) problems.push(`${rel}: bad first_attempt_pass_rate ${rate}`);
		}
	}
	assert.deepEqual(problems, []);
});

test("generated docs-agent fixtures carry a non-empty tree and a drift manifest", () => {
	const problems = [];
	const seen = new Set();
	for (const [rel, s] of fixtureDirs()) {
		if (s.agent !== "docs" || seen.has(rel)) continue;
		seen.add(rel);
		if (!existsSync(path.join(ROOT, rel)) || readdirSync(path.join(ROOT, rel)).length === 0) problems.push(`${rel}: empty fixture tree`);
		const file = path.join(ROOT, rel, "fixture.json");
		if (!existsSync(file)) {
			problems.push(`${rel}: missing fixture.json`);
			continue;
		}
		const manifest = JSON.parse(readFileSync(file, "utf8"));
		if (manifest.doc_drifts !== undefined) {
			if (!Array.isArray(manifest.doc_drifts)) problems.push(`${rel}: doc_drifts must be an array`);
			else {
				for (const d of manifest.doc_drifts) {
					if (typeof d.path !== "string") problems.push(`${rel}: drift path must be a string`);
					if (d.risk !== undefined && !RISK_CLASSES.has(d.risk)) problems.push(`${rel}: bad drift risk ${d.risk}`);
				}
			}
		}
	}
	assert.deepEqual(problems, []);
});
