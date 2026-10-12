// Docs CI detector — link checker + code-sample runner (spec: workflows/test-eval-spec.md
// §8 Q9; workflows/docs-agent/design.md §Detector 2).
//
// Built once and shared by two consumers:
//   - the eval harness `ToolRuntime.runCheck` (evals/harness/tool-roles.mjs), which runs
//     the docs `run-check` role against a provisioned fixture workspace;
//   - the production binding (`npm run docs:check`, scripts/docs-check.mjs) and
//     `PiRunner.runCheck` in shared/shim.ts, which a live docs specialist invokes.
//
// The check command is repo-configured, never model-chosen:
//   1. `docs-check.json` at the workspace root — either `{ "runner": "docs-ci", ... }`
//      (run the shared in-process detector below) or `{ "command", "args" }` for a repo
//      script;
//   2. the `docs:check` script in `package.json` (run with `npm run docs:check`);
//   3. the bindings.md default `npm run docs:check`.
//
// Execution is read-only from the runtime's point of view (the repo's own check may write
// its own scratch files) and path-jailed like the other eval tool roles: the command must
// be allow-listed and every path-shaped argument must resolve inside the workspace. Output
// is normalized into a structured pass/fail result the docs specialist consumes in its
// RESULT contract (`verdict.attested` for passing checks, `verdict.stale_sections` for
// failing links/samples — see shared/shim.ts PiRunner prompt and workflows/bindings.md).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface DocsCheckPlan {
	/** `docs-ci` runs the shared in-process detector; `command` execs the repo command. */
	kind: "docs-ci" | "command";
	command?: string;
	args?: string[];
	/** for `kind: "docs-ci"`: also execute `samples/**` (default true). */
	samples?: boolean;
	/** per-check timeout; defaults from the run-check role (300 s). */
	timeoutS?: number;
	/** which config layer produced the plan (diagnostics / trace). */
	source: string;
}

export interface DocsCheckItem {
	name: string;
	passed: boolean;
	detail?: string;
}

export interface DocsCheckResult {
	outcome: "ok" | "error" | "timeout";
	/** the check command (or the shared detector) reported success. */
	passed: boolean;
	exitCode: number | null;
	command: string;
	args: string[];
	source: string;
	checks: DocsCheckItem[];
	failures: string[];
	stdout: string;
	stderr: string;
	durationMs: number;
}

/** Role default mirrors EO-protocol §Timeouts (`run-check` 300 s). */
export const DEFAULT_DOCS_CHECK_TIMEOUT_S = 300;

/** Commands a repo-configured docs check may exec. Kept deliberately narrow. */
export const DOCS_CHECK_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
	"node",
	"npm",
	"npx",
	"python3",
	"pytest",
]);

const DOCS_CHECK_FILENAME = "docs-check.json";
const MD_EXT = /\.(md|markdown)$/i;
const SAMPLE_EXT = /\.(c|m)?js$/i;
const WALK_SKIP = new Set(["node_modules", ".git", ".wrangler", "results", ".venv-eval", "__pycache__"]);

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInside(root: string, candidate: string): boolean {
	const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	return candidate === root || candidate.startsWith(rootWithSep);
}

/** Resolve a workspace-relative path, refusing anything that escapes the workspace root. */
export function resolveInsideRoot(root: string, rel: string): string {
	const resolvedRoot = path.resolve(root);
	const abs = path.resolve(resolvedRoot, rel);
	if (!isInside(resolvedRoot, abs)) throw new Error(`path escapes workspace: ${rel}`);
	return abs;
}

function readJson(file: string): unknown | null {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Resolve the repo-configured docs check plan from the workspace. `override` is a trusted
 * harness/binding-supplied plan (PiRunner's bindings/pi.yaml value, or a test), which wins
 * over the repo files; it is still validated by `validateDocsCheckPlan`.
 */
export function resolveDocsCheckPlan(
	workspaceRoot: string,
	override?: Partial<DocsCheckPlan>,
): DocsCheckPlan {
	const root = path.resolve(workspaceRoot);
	if (override) {
		const base: DocsCheckPlan =
			override.kind === "command"
				? { kind: "command", command: override.command, args: override.args ?? [], source: override.source ?? "binding" }
				: { kind: "docs-ci", samples: override.samples, timeoutS: override.timeoutS, source: override.source ?? "binding" };
		if (override.timeoutS !== undefined) base.timeoutS = override.timeoutS;
		return validateDocsCheckPlan(base);
	}

	const configFile = path.join(root, DOCS_CHECK_FILENAME);
	if (existsSync(configFile)) {
		const cfg = readJson(configFile);
		if (!isObj(cfg)) throw new Error(`${DOCS_CHECK_FILENAME} must be a JSON object`);
		const source = DOCS_CHECK_FILENAME;
		if (cfg.runner === "docs-ci") {
			return validateDocsCheckPlan({
				kind: "docs-ci",
				samples: typeof cfg.samples === "boolean" ? cfg.samples : undefined,
				timeoutS: typeof cfg.timeout_s === "number" ? cfg.timeout_s : undefined,
				source,
			});
		}
		if (typeof cfg.command === "string") {
			return validateDocsCheckPlan({
				kind: "command",
				command: cfg.command,
				args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
				timeoutS: typeof cfg.timeout_s === "number" ? cfg.timeout_s : undefined,
				source,
			});
		}
		throw new Error(`${DOCS_CHECK_FILENAME} must declare "runner": "docs-ci" or a "command"`);
	}

	const pkg = readJson(path.join(root, "package.json"));
	if (isObj(pkg) && isObj(pkg.scripts) && typeof pkg.scripts["docs:check"] === "string") {
		return validateDocsCheckPlan({
			kind: "command",
			command: "npm",
			args: ["run", "docs:check", "--silent"],
			source: "package.json#scripts.docs:check",
		});
	}

	return validateDocsCheckPlan({
		kind: "command",
		command: "npm",
		args: ["run", "docs:check", "--silent"],
		source: "binding-default",
	});
}

/** Validate a plan: allow-listed command, path-shaped args jailed to the workspace. */
export function validateDocsCheckPlan(plan: DocsCheckPlan, workspaceRoot?: string): DocsCheckPlan {
	if (plan.kind === "docs-ci") return plan;
	const { command, args = [] } = plan;
	if (!command) throw new Error("docs check plan requires a command");
	if (!DOCS_CHECK_COMMAND_ALLOWLIST.has(command)) {
		throw new Error(`docs check command not allow-listed: ${command} (allowed: ${[...DOCS_CHECK_COMMAND_ALLOWLIST].join(", ")})`);
	}
	if (workspaceRoot) {
		const root = path.resolve(workspaceRoot);
		for (const arg of args) {
			if (typeof arg !== "string") throw new Error("docs check args must be strings");
			// Path-shaped arguments only: flags (`--silent`) and bare words are not paths.
			const pathShaped = !arg.startsWith("-") && (arg.includes("/") || /\.\w+$/.test(arg));
			if (pathShaped) resolveInsideRoot(root, arg);
		}
	}
	return plan;
}

function walkFiles(root: string, files: string[], match: (rel: string) => boolean): void {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (WALK_SKIP.has(entry)) continue;
		const abs = path.join(root, entry);
		let st;
		try {
			st = statSync(abs);
		} catch {
			continue;
		}
		if (st.isDirectory()) walkFiles(abs, files, match);
		else if (st.isFile() && match(path.relative(root, abs))) files.push(abs);
	}
}

// ---------- detector 2a: internal link checker ----------

export function stripFencedCode(markdown: string): string {
	return markdown
		.replace(/^```[\s\S]*?^```\s*$/gm, "")
		.replace(/^~~~[\s\S]*?^~~~\s*$/gm, "")
		.replace(/`[^`\n]*`/g, "");
}

function isExternalTarget(target: string): boolean {
	return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target);
}

/** Collect markdown link/image targets, ignoring fenced code and external URLs. */
export function internalLinkTargets(markdown: string): string[] {
	const body = stripFencedCode(markdown);
	const out: string[] = [];
	const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
	for (const m of body.matchAll(re)) out.push(m[1]!);
	return out;
}

export function findBrokenInternalLinks(root: string): DocsCheckItem[] {
	const resolvedRoot = path.resolve(root);
	const files: string[] = [];
	walkFiles(resolvedRoot, files, (rel) => MD_EXT.test(rel));
	const items: DocsCheckItem[] = [];
	for (const file of files) {
		const rel = path.relative(resolvedRoot, file);
		let markdown: string;
		try {
			markdown = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const rawTarget of internalLinkTargets(markdown)) {
			if (isExternalTarget(rawTarget)) continue;
			let target = rawTarget;
			try {
				target = decodeURIComponent(rawTarget);
			} catch {
				/* keep the raw target */
			}
			target = target.split("#")[0]!.split("?")[0]!;
			if (!target) continue;
			// Accept a link relative to the containing file or relative to the repo root
			// (both are common in docs); only a target that resolves to neither is broken.
			const candidates = [path.resolve(path.dirname(file), target), path.resolve(resolvedRoot, target)];
			const ok = candidates.some((c) => isInside(resolvedRoot, c) && existsSync(c));
			if (!ok) {
				items.push({ name: `link:${rel} -> ${rawTarget}`, passed: false, detail: "missing or escaping target" });
			}
		}
	}
	return items;
}

// ---------- detector 2b: code-sample runner ----------

export function findDocsSamples(root: string): string[] {
	const resolvedRoot = path.resolve(root);
	const samplesDir = path.join(resolvedRoot, "samples");
	if (!existsSync(samplesDir)) return [];
	const files: string[] = [];
	walkFiles(samplesDir, files, (rel) => SAMPLE_EXT.test(rel));
	return files.sort();
}

export function runDocsSamples(root: string, { timeoutMs = 10_000 } = {}): DocsCheckItem[] {
	const resolvedRoot = path.resolve(root);
	const items: DocsCheckItem[] = [];
	for (const file of findDocsSamples(resolvedRoot)) {
		const rel = path.relative(resolvedRoot, file);
		try {
			execFileSync(process.execPath, [file], {
				cwd: resolvedRoot,
				encoding: "utf8",
				timeout: timeoutMs,
				maxBuffer: 1 << 20,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			items.push({ name: `sample:${rel}`, passed: true });
		} catch (err) {
			const e = err as { signal?: string; status?: number | null; stderr?: string | Buffer };
			const stderr = String(e.stderr ?? "").trim();
			items.push({
				name: `sample:${rel}`,
				passed: false,
				detail: e.signal === "SIGTERM" ? "timed out" : stderr.split("\n").slice(0, 3).join(" | ") || `exit ${e.status ?? "?"}`,
			});
		}
	}
	return items;
}

export interface DocsCiReport {
	passed: boolean;
	checks: DocsCheckItem[];
	failures: string[];
}

/** The shared docs-CI detector: internal links + (optionally) code samples. */
export function runDocsCi(root: string, { samples = true } = {}): DocsCiReport {
	const checks = findBrokenInternalLinks(root);
	if (samples) checks.push(...runDocsSamples(root));
	const failures = checks
		.filter((c) => !c.passed)
		.map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name));
	return { passed: failures.length === 0, checks, failures };
}

// ---------- output normalization ----------

/** Parse a repo check's stdout into structured checks; falls back to exit/stderr. */
export function parseDocsCheckOutput(
	stdout: string,
	stderr: string,
	exitCode: number | null,
): { checks: DocsCheckItem[]; failures: string[] } {
	const trimmed = String(stdout ?? "").trim();
	if (trimmed) {
		try {
			const parsed = JSON.parse(trimmed);
			if (isObj(parsed) && Array.isArray(parsed.checks)) {
				const checks = parsed.checks
					.filter(isObj)
					.map((c) => ({
						name: String(c.name ?? "docs-check"),
						passed: Boolean(c.passed ?? c.pass),
						detail: c.detail === undefined ? undefined : String(c.detail),
					}));
				const failures = Array.isArray(parsed.failures)
					? parsed.failures.map(String)
					: checks.filter((c) => !c.passed).map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name));
				return { checks, failures };
			}
		} catch {
			/* not a JSON report; fall through */
		}
	}
	const lines = String(stderr ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, 20);
	return {
		checks: [{ name: "docs-check", passed: exitCode === 0, detail: lines[0] }],
		failures: exitCode === 0 ? [] : lines,
	};
}

/**
 * Execute a docs check for a workspace and return the structured pass/fail result.
 * `docs-ci` runs the shared detector in-process; `command` executes the allow-listed,
 * path-jailed repo command with no shell.
 */
export function runDocsCheck(
	workspaceRoot: string,
	{ plan, timeoutMs }: { plan?: Partial<DocsCheckPlan>; timeoutMs?: number } = {},
): DocsCheckResult {
	const root = path.resolve(workspaceRoot);
	const resolved = resolveDocsCheckPlan(root, plan);
	const timeout =
		timeoutMs ?? (resolved.timeoutS !== undefined ? resolved.timeoutS * 1000 : DEFAULT_DOCS_CHECK_TIMEOUT_S * 1000);
	const started = Date.now();

	if (resolved.kind === "docs-ci") {
		const report = runDocsCi(root, { samples: resolved.samples !== false });
		return {
			outcome: report.passed ? "ok" : "error",
			passed: report.passed,
			exitCode: report.passed ? 0 : 1,
			command: "docs-ci",
			args: [],
			source: resolved.source,
			checks: report.checks,
			failures: report.failures,
			stdout: JSON.stringify(report),
			stderr: "",
			durationMs: Date.now() - started,
		};
	}

	validateDocsCheckPlan(resolved, root);
	const command = resolved.command!;
	const args = resolved.args ?? [];
	try {
		const stdout = execFileSync(command, args, {
			cwd: root,
			encoding: "utf8",
			timeout,
			maxBuffer: 1 << 22,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const parsed = parseDocsCheckOutput(stdout, "", 0);
		return {
			outcome: parsed.failures.length ? "error" : "ok",
			passed: parsed.failures.length === 0,
			exitCode: 0,
			command,
			args,
			source: resolved.source,
			checks: parsed.checks,
			failures: parsed.failures,
			stdout,
			stderr: "",
			durationMs: Date.now() - started,
		};
	} catch (err) {
		const e = err as { signal?: string; status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
		const stdout = String(e.stdout ?? "");
		const stderr = String(e.stderr ?? "");
		const timedOut = e.signal === "SIGTERM";
		const exitCode = timedOut ? null : (e.status ?? null);
		const parsed = parseDocsCheckOutput(stdout, stderr, exitCode);
		return {
			outcome: timedOut ? "timeout" : "error",
			passed: false,
			exitCode,
			command,
			args,
			source: resolved.source,
			checks: parsed.checks,
			failures: timedOut ? ["docs check timed out"] : parsed.failures,
			stdout,
			stderr,
			durationMs: Date.now() - started,
		};
	}
}
