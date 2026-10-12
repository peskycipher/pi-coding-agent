#!/usr/bin/env node
// Static rubric CLI (spec §6): `npm run eval:rubric`.
//
// Checks every rubric under evals/rubric/ against the spec docs; a missing rule exits
// non-zero, which is what blocks a spec PR that deletes a rule.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadYamlDir } from "../harness/config.mjs";
import { checkRubric } from "./rubric-check.mjs";

export const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Check every rubric file; returns `{ ok, totalRules, passedRules, failures }`. */
export function runRubricChecks(root = ROOT) {
	const rubrics = loadYamlDir(path.join(root, "evals/rubric"));
	const failures = [];
	let totalRules = 0;
	let passedRules = 0;
	for (const [name, rubric] of Object.entries(rubrics)) {
		const result = checkRubric(rubric, { root });
		totalRules += result.total;
		passedRules += result.passed;
		for (const f of result.failures) failures.push({ rubric: name, id: f.id, missing: f.missing });
	}
	return { ok: failures.length === 0, totalRules, passedRules, failures };
}

async function main() {
	const result = runRubricChecks();
	console.log(`rubric: ${result.passedRules}/${result.totalRules} rules present across ${Object.keys(loadYamlDir(path.join(ROOT, "evals/rubric"))).length} files`);
	for (const f of result.failures) console.log(`  MISSING ${f.rubric}:${f.id} in ${f.missing.join(", ")}`);
	return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((code) => process.exit(code));
}
