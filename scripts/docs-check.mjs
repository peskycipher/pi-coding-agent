#!/usr/bin/env node
// Production docs-CI entry point (bindings/pi.yaml `agents.docs.roles.run-check`:
// `npm run docs:check`). The detector itself is built once in shared/docs-check.ts and
// shared with the eval harness's `run-check` role (spec: workflows/test-eval-spec.md §8 Q9);
// this script only wires it to a command and a process exit code.
//
// Usage: node scripts/docs-check.mjs [workspace] [--no-samples]
// Prints the structured report as JSON on stdout; exits 1 on any failing check.

import { runDocsCi } from "../shared/docs-check.ts";
import path from "node:path";

const args = process.argv.slice(2);
const samples = !args.includes("--no-samples");
const rootArg = args.find((a) => !a.startsWith("-"));
const root = rootArg ? path.resolve(rootArg) : process.cwd();

const report = runDocsCi(root, { samples });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) {
	process.stderr.write(`${report.failures.length} docs check failure(s)\n`);
	process.exit(1);
}
