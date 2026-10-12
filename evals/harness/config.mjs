// YAML loader for eval config, rubric, and model files.
//
// The spec authors scenarios/rubrics/models as YAML (test-eval-spec.md §5/§6). js-yaml is
// the parser; it is declared as a devDependency so the eval toolchain is self-describing.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

/** Parse a YAML string, turning parser failures into a named error. */
export function parseYaml(text, label = "<yaml>") {
	try {
		return yaml.load(text);
	} catch (err) {
		throw new Error(`YAML parse failed for ${label}: ${err.message}`);
	}
}

/** Load and parse a YAML file. */
export function loadYamlFile(file) {
	return parseYaml(readFileSync(file, "utf8"), file);
}

/** Load all `*.yaml` files in a directory keyed by basename (sans extension). */
export function loadYamlDir(dir) {
	const out = {};
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
		out[entry.replace(/\.ya?ml$/, "")] = loadYamlFile(path.join(dir, entry));
	}
	return out;
}
