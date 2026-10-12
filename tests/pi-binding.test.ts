import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { loadYamlFile } from "../evals/harness/config.mjs";
import { validateBindingDocument } from "../shared/bindings.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const doc = loadYamlFile(path.join(ROOT, "bindings/pi.yaml"));

test("bindings/pi.yaml is accepted by the binding validator", () => {
	const result = validateBindingDocument(doc);
	assert.ok(result.ok, result.ok ? "" : result.errors.join("\n"));
});

test("bindings/pi.yaml declares the harness and every deployed specialist", () => {
	assert.equal(doc.harness, "pi");
	assert.deepEqual(
		Object.keys(doc.agents).sort(),
		["build", "contrarian", "docs", "plan", "scout", "steelman", "test"],
	);
});

test("bindings/pi.yaml binds the docs run-check role to the docs:check script", () => {
	assert.equal(doc.agents.docs.roles["run-check"].command, "npm run docs:check");
});
