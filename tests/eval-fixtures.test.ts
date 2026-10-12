import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { generate } from "../evals/fixtures/generate.mjs";
import { ROOT, availableRunners, loadScenarios, scenarioPresent } from "../evals/harness/run.mjs";

// The frozen flake fixtures predate the catalog generator and are scored from
// scenarios.yaml manifest_hints only; they intentionally carry no fixture.json.
const PRESERVED_NO_MANIFEST = new Set([
	"evals/fixtures/out/jest-flake-order",
	"evals/fixtures/out/pytest-flake-order",
	"evals/fixtures/out/jest-flake-seed",
]);

// The C2 pytest variant is the generated counterpart to the preserved `jest-flake-seed`
// binding (spec §3 C2: 1 deterministic defect + 1 seeded flake + passes).
const C2_PYTEST_DIR = "evals/fixtures/out/C2-defect-flake-mix-pytest";

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

test("every declared fixture exists", () => {
	const missing = [];
	for (const [rel, s] of fixtureDirs()) {
		if (!existsSync(path.join(ROOT, rel))) missing.push(`${s.id}: ${rel}`);
	}
	assert.deepEqual(missing, []);
});

test("the C2 pytest variant carries the defect+flake ground truth manifest", () => {
	const manifestPath = path.join(ROOT, C2_PYTEST_DIR, "fixture.json");
	assert.ok(existsSync(manifestPath), `${C2_PYTEST_DIR}: missing fixture.json`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const counts = {};
	for (const t of manifest.tests ?? []) counts[t.expectedClass] = (counts[t.expectedClass] ?? 0) + 1;
	assert.equal(counts.defect, 1, "expected exactly one deterministic defect");
	assert.equal(counts.flake, 1, "expected exactly one seeded flake");
	assert.ok((counts.pass ?? 0) >= 1, "expected at least one passing test");
	assert.equal(manifest.first_attempt_pass_rate, 0.5);

	const source = readFileSync(path.join(ROOT, C2_PYTEST_DIR, "tests/test_mix.py"), "utf8");
	assert.match(source, /def test_deterministic_defect\(\)/);
	assert.match(source, /def test_seeded_flake\(\)/);
	assert.match(source, /TEST_SEED/);
});

test("the C2 scenario is present for both runner bindings", () => {
	const c2 = loadScenarios(ROOT).find((s) => s.id === "C2-defect-flake-mix");
	assert.ok(c2, "C2 scenario missing");
	assert.ok(scenarioPresent(c2));
	assert.deepEqual(availableRunners(c2).sort(), ["jest", "pytest"]);
});

test("C12 hanging-test stays out of the core suite pending the §8 Q4 timeout bound", () => {
	// TODO(spec §8 Q4): the hard-kill wall clock for a hanging test is an OWNER decision.
	// Keep C12 out of the core set and out of any executed fixture/calibration suite until
	// that bound is resolved; the fixture is emitted for the catalog shape only.
	const c12 = loadScenarios(ROOT).find((s) => s.id === "C12-hanging-test");
	assert.ok(c12, "C12 scenario missing");
	assert.equal(c12.core, false, "C12 must not run in the core suite");
});

test("generated test-agent fixtures carry schema-shaped ground truth manifests", () => {
	const problems = [];
	const seen = new Set();
	for (const [rel, s] of fixtureDirs()) {
		if (s.agent !== "test" || seen.has(rel) || PRESERVED_NO_MANIFEST.has(rel)) continue;
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
		// Every D fixture must declare the shared docs-CI detector so the run-check role is
		// reachable (spec §8 Q9).
		const checkConfig = path.join(ROOT, rel, "docs-check.json");
		if (!existsSync(checkConfig)) problems.push(`${rel}: missing docs-check.json`);
		else {
			const cfg = JSON.parse(readFileSync(checkConfig, "utf8"));
			if (cfg.runner !== "docs-ci") problems.push(`${rel}: docs-check.json runner must be docs-ci`);
		}
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
