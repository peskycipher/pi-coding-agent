// Tool-role implementations for the eval harness (spec: workflows/test-eval-spec.md §1/§6,
// roles per workflows/test/workflow.md and workflows/docs-agent/design.md).
//
// The harness executes the real seven test roles (+ docs run-check/notify) against fixture
// repos. Every call is traced through TraceRecorder, path-jailed to the provisioned
// workspace, and charged against the DISPATCH budget. `test-edit` is gated to test code and
// produces the diff that the S1/S2 safety gates consume (spec A6).
//
// Runner adapters mirror evals/fixtures/generate.mjs so calibration and eval invoke the
// same way (jest --runInBand --silent --watchman=false; pytest -p no:cacheprovider).

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
	cpSync,
} from "node:fs";
import path from "node:path";

import { TraceRecorder } from "./trace.mjs";

// EO-protocol §Timeouts defaults (single authority), mirrored locally so the eval harness
// is runnable without importing the Worker bundle.
export const DEFAULT_ROLE_TIMEOUT_S = {
	"run-suite": 1800,
	"run-test": 300,
	"read-log": 60,
	"workspace-read": 60,
	"env-check": 60,
	"git-info": 300,
	"test-edit": 60,
	"notify": 30,
};

export const RUNNERS = {
	jest: {
		command: "npx",
		args: ["jest", "--runInBand", "--silent", "--watchman=false"],
	},
	pytest: {
		command: process.env.PYTEST || "python3",
		args: ["-m", "pytest", "-p", "no:cacheprovider", "--tb=no", "-q"],
	},
};

export class ToolRoleError extends Error {
	constructor(message) {
		super(message);
		this.name = "ToolRoleError";
	}
}
export class GateRejectedError extends ToolRoleError {
	constructor(message) {
		super(message);
		this.name = "GateRejectedError";
	}
}
export class BudgetExceededError extends Error {
	constructor(message) {
		super(message);
		this.name = "BudgetExceededError";
	}
}
export class TimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = "TimeoutError";
	}
}

/** True when `rel` (workspace-relative) is a docs path the docs agent may edit. */
export function isDocsPath(rel) {
	const norm = rel.replaceAll("\\", "/").replace(/^\.\//, "");
	if (norm.startsWith("../") || path.isAbsolute(norm)) return false;
	const segments = norm.split("/");
	if (segments.includes("docs") || segments.includes("documentation")) return true;
	const base = segments[segments.length - 1];
	return base === "README.md" || base === "CHANGELOG.md" || base === "CONTRIBUTING.md";
}

/** True when `rel` (workspace-relative) is test code / fixtures / quarantine annotations. */
export function isTestPath(rel) {
	const norm = rel.replaceAll("\\", "/").replace(/^\.\//, "");
	if (norm.startsWith("../") || path.isAbsolute(norm)) return false;
	const segments = norm.split("/");
	const base = segments[segments.length - 1];
	if (["test", "tests", "__tests__", "fixtures", "e2e", "spec", "specs"].some((s) => segments.includes(s))) return true;
	if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
	if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base)) return true;
	if (base === "conftest.py") return true;
	return false;
}

/** Resolve a workspace-relative path, refusing anything that escapes the workspace root. */
export function resolveInside(root, rel) {
	if (typeof rel !== "string" || rel === "") throw new ToolRoleError("path is required");
	const abs = path.resolve(root, rel);
	const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	if (abs !== root && !abs.startsWith(rootWithSep)) throw new ToolRoleError(`path escapes workspace: ${rel}`);
	return abs;
}

/**
 * Minimal, dependency-free unified diff (single hunk). It is the S-gate substrate: the
 * scorer reads added/removed lines, not patch application. Returns "" when unchanged.
 */
export function unifiedDiff(oldText, newText, { path: filePath = "file" } = {}) {
	if (oldText === newText) return "";
	const a = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
	const b = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
	const m = a.length;
	const n = b.length;
	const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) ops.push(` ${a[i++]}`);
		else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(`-${a[i++]}`);
		else ops.push(`+${b[j++]}`);
	}
	while (i < m) ops.push(`-${a[i++]}`);
	while (j < n) ops.push(`+${b[j++]}`);
	return [
		`--- a/${filePath}`,
		`+++ b/${filePath}`,
		`@@ -1,${m} +1,${n} @@`,
		...ops,
		"",
	].join("\n");
}

/** Recursively copy a committed fixture into a fresh workspace (the shim provisions per run). */
export function provisionWorkspace(fixtureDir, dest) {
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(path.dirname(dest), { recursive: true });
	cpSync(fixtureDir, dest, { recursive: true });
	return dest;
}

/**
 * One dispatch's tool surface. Roles are methods; every invocation is budgeted and
 * traced. The runtime never touches remotes (git-info is read-only local; no remote verbs).
 */
export class ToolRuntime {
	constructor({ workspace, trace, budget = {}, agent, scenario, dispatchId } = {}) {
		if (!workspace) throw new ToolRoleError("ToolRuntime requires a workspace");
		this.workspace = path.resolve(workspace);
		this.trace =
			trace ??
			new TraceRecorder({ agent: agent ?? "test", scenario: scenario ?? "C0-harness", dispatchId });
		this.budget = {
			tool_calls: budget.tool_calls ?? 15,
			seconds: budget.seconds ?? 300,
		};
		this.consumed = 0;
		this.notifications = [];
		this.startedAt = Date.now();
	}

	get remainingToolCalls() {
		return Math.max(0, this.budget.tool_calls - this.consumed);
	}

	#charge(role, args, files, diff) {
		if (this.consumed >= this.budget.tool_calls) {
			this.trace.record({ role, args, outcome: "error", durationMs: 0, files, diff });
			throw new BudgetExceededError(`tool-call budget exhausted (${this.budget.tool_calls}) at ${role}`);
		}
		if (Date.now() - this.startedAt > this.budget.seconds * 1000) {
			this.trace.record({ role, args, outcome: "timeout", durationMs: 0, files, diff });
			throw new BudgetExceededError(`wall-clock budget exhausted (${this.budget.seconds}s) at ${role}`);
		}
		this.consumed++;
	}

	async #invoke(role, args, fn, { files, diff } = {}) {
		this.#charge(role, args, files, diff);
		const start = Date.now();
		try {
			const result = await fn();
			const outcome = result?.outcome ?? "ok";
			this.trace.record({
				role,
				args,
				outcome,
				durationMs: Date.now() - start,
				files: result?.files ?? files,
				diff: result?.diff ?? diff,
			});
			return result;
		} catch (err) {
			const outcome = err instanceof TimeoutError ? "timeout" : "error";
			this.trace.record({ role, args, outcome, durationMs: Date.now() - start, files, diff });
			throw err;
		}
	}

	#runnerSpec(runner) {
		const spec = RUNNERS[runner];
		if (!spec) throw new ToolRoleError(`unknown runner binding: ${runner}`);
		return spec;
	}

	#exec(command, args, { env = {}, timeoutMs = 300_000 } = {}) {
		const started = Date.now();
		const res = spawnSync(command, args, {
			cwd: this.workspace,
			encoding: "utf8",
			maxBuffer: 1 << 24,
			timeout: timeoutMs,
			env: { ...process.env, ...env },
		});
		const durationMs = Date.now() - started;
		if (res.error && (res.error.code === "ETIMEDOUT" || res.signal === "SIGTERM")) {
			return { outcome: "timeout", exitCode: null, stdout: res.stdout ?? "", stderr: res.stderr ?? "", durationMs };
		}
		if (res.error) {
			return { outcome: "error", exitCode: null, stdout: res.stdout ?? "", stderr: String(res.error.message), durationMs };
		}
		return {
			outcome: res.status === 0 ? "ok" : "error",
			exitCode: res.status,
			stdout: res.stdout ?? "",
			stderr: res.stderr ?? "",
			durationMs,
		};
	}

	/** run-suite / run-test: execute the bound runner over `target` (full or named). */
	async runSuite({ runner, target, env, timeoutMs } = {}) {
		return this.#runTests("run-suite", { runner, target, env, timeoutMs });
	}

	async runTest({ runner, target, env, timeoutMs } = {}) {
		return this.#runTests("run-test", { runner, target, env, timeoutMs });
	}

	#runTests(role, { runner, target, env, timeoutMs }) {
		return this.#invoke(
			role,
			{ runner, target: target ?? "full" },
			() => {
				const spec = this.#runnerSpec(runner);
				const args = target && target !== "full" ? [...spec.args, target] : [...spec.args];
				return this.#exec(spec.command, args, {
					env,
					timeoutMs: timeoutMs ?? DEFAULT_ROLE_TIMEOUT_S[role] * 1000,
				});
			},
		);
	}

	/** read-log: read a file inside the workspace (log, runner output, artifact). */
	async readLog({ path: rel, tail } = {}) {
		return this.#invoke("read-log", { path: rel, tail }, () => {
			const abs = resolveInside(this.workspace, rel);
			if (!existsSync(abs)) throw new ToolRoleError(`no such log: ${rel}`);
			let text = readFileSync(abs, "utf8");
			if (typeof tail === "number" && tail > 0) {
				const lines = text.split("\n");
				text = lines.slice(Math.max(0, lines.length - tail)).join("\n");
			}
			return { outcome: "ok", text, files: [rel] };
		});
	}

	/** workspace-read: glob / grep / read, all read-only and path-jailed. */
	async workspaceRead({ op, pattern, path: rel, glob } = {}) {
		return this.#invoke("workspace-read", { op, pattern, path: rel, glob }, () => {
			if (op === "read") {
				const abs = resolveInside(this.workspace, rel);
				if (!existsSync(abs)) throw new ToolRoleError(`no such file: ${rel}`);
				return { outcome: "ok", text: readFileSync(abs, "utf8"), files: [rel] };
			}
			if (op === "glob") {
				const matcher = globToRegExp(glob ?? pattern ?? "**/*");
				const files = walk(this.workspace)
					.map((f) => path.relative(this.workspace, f))
					.filter((f) => matcher.test(f));
				return { outcome: "ok", files };
			}
			if (op === "grep") {
				if (!pattern) throw new ToolRoleError("grep requires a pattern");
				const re = new RegExp(pattern);
				const hits = [];
				for (const f of walk(this.workspace)) {
					let text;
					try {
						text = readFileSync(f, "utf8");
					} catch {
						continue;
					}
					text.split("\n").forEach((line, idx) => {
						if (re.test(line)) hits.push(`${path.relative(this.workspace, f)}:${idx + 1}: ${line.trim()}`);
					});
				}
				return { outcome: "ok", hits };
			}
			throw new ToolRoleError(`unknown workspace-read op: ${op}`);
		});
	}

	/** env-check: runner/runtime/fixture presence before any suite burn (Stage 2). */
	async envCheck({ runner, checks = [] } = {}) {
		return this.#invoke("env-check", { runner, checks: checks.map((c) => c.name) }, () => {
			const gaps = [];
			const results = [];
			const probes = [...checks];
			if (runner && RUNNERS[runner]) {
				probes.unshift({ name: `${runner}-version`, command: RUNNERS[runner].command, args: ["--version"] });
			}
			for (const probe of probes) {
				const res = this.#exec(probe.command, probe.args ?? [], { timeoutMs: (probe.timeoutS ?? 30) * 1000 });
				results.push({ name: probe.name, outcome: res.outcome, stdout: res.stdout.trim(), stderr: res.stderr.trim() });
				if (probe.required !== false && res.outcome !== "ok") gaps.push({ name: probe.name, required: true });
			}
			return { outcome: gaps.length ? "error" : "ok", gaps, probes: results };
		});
	}

	/** git-info: read-only local git (history/blame). Remote/staging verbs are refused. */
	async gitInfo({ args = [] } = {}) {
		const READ_ONLY = new Set(["log", "blame", "show", "diff", "status", "rev-parse", "describe", "shortlog"]);
		const verb = args[0];
		if (!READ_ONLY.has(verb)) throw new GateRejectedError(`git-info is read-only; refused subcommand: ${verb}`);
		return this.#invoke("git-info", { args }, () => {
			const res = this.#exec("git", ["-C", this.workspace, ...args], { timeoutMs: DEFAULT_ROLE_TIMEOUT_S["git-info"] * 1000 });
			return { ...res, files: [] };
		});
	}

	/**
	 * test-edit: the one gated role. Test code / fixtures only; product-code edits are
	 * refused before any write (S2). Returns the resulting diff (S1 substrate).
	 */
	async testEdit({ path: rel, content, remove = false } = {}) {
		return this.#invoke(
			"test-edit",
			{ path: rel, bytes: typeof content === "string" ? content.length : 0, remove },
			() => {
				if (!isTestPath(rel)) throw new GateRejectedError(`test-edit refused: ${rel} is not test code`);
				const abs = resolveInside(this.workspace, rel);
				const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
				if (remove) {
					rmSync(abs, { force: true });
				} else {
					mkdirSync(path.dirname(abs), { recursive: true });
					writeFileSync(abs, content ?? "");
				}
				const after = remove ? "" : (content ?? "");
				return { outcome: "ok", files: [rel], diff: unifiedDiff(before, after, { path: rel }) };
			},
			{ files: [rel] },
		);
	}

	/**
	 * docs-edit: the docs agent's gated role. docs/** and top-level markdown only; product
	 * code and tests are read-only (S6 substrate). Returns the resulting diff.
	 */
	async docsEdit({ path: rel, content, remove = false } = {}) {
		return this.#invoke(
			"docs-edit",
			{ path: rel, bytes: typeof content === "string" ? content.length : 0, remove },
			() => {
				if (!isDocsPath(rel)) throw new GateRejectedError(`docs-edit refused: ${rel} is not a docs path`);
				const abs = resolveInside(this.workspace, rel);
				const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
				if (remove) {
					rmSync(abs, { force: true });
				} else {
					mkdirSync(path.dirname(abs), { recursive: true });
					writeFileSync(abs, content ?? "");
				}
				const after = remove ? "" : (content ?? "");
				return { outcome: "ok", files: [rel], diff: unifiedDiff(before, after, { path: rel }) };
			},
			{ files: [rel] },
		);
	}

	/** notify: report / escalation to the requesting surface. No workspace effect. */
	async notify(payload) {
		return this.#invoke("notify", { kind: payload?.kind ?? "report" }, () => {
			this.notifications.push(payload);
			return { outcome: "ok", payload };
		});
	}
}

// ---------- small fs helpers ----------

function walk(root) {
	const out = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "__pycache__") continue;
		const abs = path.join(root, entry.name);
		if (entry.isDirectory()) out.push(...walk(abs));
		else if (statSync(abs).isFile()) out.push(abs);
	}
	return out;
}

/** Translate a glob (`*`, `**`, `?`) into an anchored RegExp over `/`-separated paths. */
export function globToRegExp(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}
