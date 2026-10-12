// Static rubric checker (spec: workflows/test-eval-spec.md §5).
//
// Presence-only, deterministic: each rule names one or more spec files and a phrase that
// must appear (whitespace-normalized, case-insensitive). A deleted rule fails the check,
// which is what blocks a spec PR. No LLM in this path.

import { readFileSync } from "node:fs";
import path from "node:path";

import { loadYamlFile } from "../harness/config.mjs";

/** Validate the shape of a rubric (array of rule objects). */
export function validateRubric(rubric, label = "<rubric>") {
	const errors = [];
	if (!Array.isArray(rubric)) return { ok: false, errors: [`${label}: rubric must be a list`] };
	const seen = new Set();
	rubric.forEach((rule, i) => {
		const where = `${label}[${i}]`;
		if (!rule || typeof rule !== "object") {
			errors.push(`${where}: rule must be an object`);
			return;
		}
		if (!rule.id) errors.push(`${where}: missing id`);
		else if (seen.has(rule.id)) errors.push(`${where}: duplicate id ${rule.id}`);
		else seen.add(rule.id);
		if (!rule.pattern) errors.push(`${where}: missing pattern`);
		if (!Array.isArray(rule.sources) || rule.sources.length === 0) errors.push(`${where}: missing sources`);
	});
	return errors.length ? { ok: false, errors } : { ok: true };
}

function normalize(text) {
	return text.replace(/\s+/g, " ").toLowerCase();
}

function matches(rule, text) {
	const hay = normalize(text);
	if (rule.match === "regex") return new RegExp(rule.pattern, "i").test(hay);
	return hay.includes(rule.pattern.toLowerCase());
}

/**
 * Check one rubric. `root` is the repository root; sources are resolved against it.
 * Returns `{ ok, total, passed, failures }` with a per-rule verdict and the sources read.
 */
export function checkRubric(rubric, { root }) {
	const validation = validateRubric(rubric, "rubric");
	const checks = [];
	for (const rule of Array.isArray(rubric) ? rubric : []) {
		const sources = rule.sources ?? [];
		let found = false;
		const missing = [];
		for (const src of sources) {
			try {
				const text = readFileSync(path.resolve(root, src), "utf8");
				if (matches(rule, text)) {
					found = true;
					break;
				}
				missing.push(src);
			} catch (err) {
				missing.push(`${src} (${err.code ?? err.message})`);
			}
		}
		checks.push({ id: rule.id, pass: found, sources, missing });
	}
	const failures = checks.filter((c) => !c.pass);
	return {
		ok: validation.ok && failures.length === 0,
		validation,
		total: checks.length,
		passed: checks.length - failures.length,
		failures,
		checks,
	};
}

/** Check a rubric file from disk. */
export function checkRubricFile(file, { root }) {
	return checkRubric(loadYamlFile(file), { root });
}
