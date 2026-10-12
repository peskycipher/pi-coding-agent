// Specialist shim — tool-role implementations and SpecialistRunner bindings
// (workflows/bindings.md; evals tool-trace record per test-eval-spec.md §6).
//
// The tool shim executes scout's read roles (glob, grep, read) for real against a
// workspace directory. The model runner is specialist-aware: it loads the system prompt
// for `dispatch.specialist` and restates that specialist's RESULT contract, so the harness
// can drive scout, plan, build, test, docs, and the adversarial gate pair.
//   - ScriptedRunner: deterministic RESULT payloads for tests/harness verification
//   - PiRunner: real model run via the local pi CLI (--mode json, no session),
//     extracting the fenced-JSON RESULT block from the model output.
//
// Test/docs role execution (run-suite, env-check, git-info, gated edits) is bound at
// install per workflows/bindings.md; it is the eval harness's job (test-eval-spec.md §6),
// not this runtime shim's. The docs own-check role (`run-check`) is the exception: it is
// built once in shared/docs-check.ts (spec §8 Q9) and exposed here as `PiRunner.runCheck`
// so a live docs specialist can invoke the repo-configured docs check.
//
// Traces mirror evals/schemas/tool-trace.schema.json fields (args digests only).

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DispatchRecord, Specialist, SpecialistRunner } from "./io.ts";
import {
	resolveDocsCheckPlan,
	runDocsCheck,
	type DocsCheckPlan,
	type DocsCheckResult,
} from "./docs-check.ts";

export interface ToolTraceRecord {
	ts: string;
	agent: string;
	role: string;
	argsDigest: string;
	outcome: "ok" | "error" | "timeout";
	durationMs: number;
	files?: string[];
}

export type ToolRole = "glob" | "grep" | "read";

function digest(s: string, max = 200): string {
	return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Executes scout tool roles against a workspace — the real read-only shim. */
export class ScoutToolShim {
	readonly trace: ToolTraceRecord[] = [];
	private toolCalls = 0;
	private readonly budget: { tool_calls: number };
	constructor(workspaceRoot: string, budget: { tool_calls: number }) {
		this.workspaceRoot = workspaceRoot;
		this.budget = budget;
	}
	private readonly workspaceRoot: string;

	get consumedToolCalls(): number {
		return this.toolCalls;
	}
	get budgetExhausted(): boolean {
		return this.toolCalls > this.budget.tool_calls;
	}

	private record(role: ToolRole, argsDigest: string, outcome: ToolTraceRecord["outcome"], durationMs: number, files?: string[]) {
		this.trace.push({ ts: new Date().toISOString(), agent: "scout", role, argsDigest, outcome, durationMs, files });
	}

	/** walk the workspace for a glob-ish suffix/pattern match */
	glob(pattern: string): string[] {
		const t0 = Date.now();
		this.toolCalls++;
		try {
			const out: string[] = [];
			const walk = (dir: string) => {
				for (const entry of readdirSync(dir)) {
					const p = path.join(dir, entry);
					const rel = path.relative(this.workspaceRoot, p);
					if (statSync(p).isDirectory()) walk(p);
					else if (pattern === "*" || rel.includes(pattern)) out.push(rel);
				}
			};
			walk(this.workspaceRoot);
			this.record("glob", pattern, "ok", Date.now() - t0, out.slice(0, 20));
			return out;
		} catch (e) {
			this.record("glob", pattern, "error", Date.now() - t0);
			throw e;
		}
	}

	grep(needle: string): { file: string; line: number; text: string }[] {
		const t0 = Date.now();
		this.toolCalls++;
		try {
			const out: { file: string; line: number; text: string }[] = [];
			const walk = (dir: string) => {
				for (const entry of readdirSync(dir)) {
					const p = path.join(dir, entry);
					if (statSync(p).isDirectory()) walk(p);
					else if (entry !== "__state.sentinel") {
						const lines = readFileSync(p, "utf8").split("\n");
						lines.forEach((line, i) => {
							if (line.includes(needle)) out.push({ file: path.relative(this.workspaceRoot, p), line: i + 1, text: line.trim().slice(0, 200) });
						});
					}
				}
			};
			walk(this.workspaceRoot);
			this.record("grep", needle, "ok", Date.now() - t0, out.slice(0, 20).map((h) => h.file));
			return out;
		} catch (e) {
			this.record("grep", needle, "error", Date.now() - t0);
			throw e;
		}
	}

	read(rel: string): string {
		const t0 = Date.now();
		this.toolCalls++;
		try {
			const body = readFileSync(path.join(this.workspaceRoot, rel), "utf8");
			this.record("read", rel, "ok", Date.now() - t0, [rel]);
			return body;
		} catch (e) {
			this.record("read", rel, "error", Date.now() - t0, [rel]);
			throw e;
		}
	}
}

/** Deterministic runner — returns a schema-valid scout RESULT without a model. */
export class ScriptedRunner implements SpecialistRunner {
	private readonly payload: unknown | ((d: DispatchRecord) => unknown);
	constructor(payload: unknown | ((d: DispatchRecord) => unknown)) {
		this.payload = payload;
	}
	async run(dispatch: DispatchRecord): Promise<unknown> {
		return typeof this.payload === "function" ? (this.payload as (d: DispatchRecord) => unknown)(dispatch) : structuredClone(this.payload);
	}
}

export const SPECIALIST_SYSTEM_PROMPT_FILES: Readonly<Record<Specialist, string>> = {
	scout: path.join(new URL("../workflows/scout/system-prompt.md", import.meta.url).pathname),
	plan: path.join(new URL("../workflows/planning/system-prompt.md", import.meta.url).pathname),
	build: path.join(new URL("../workflows/build/system-prompt.md", import.meta.url).pathname),
	test: path.join(new URL("../workflows/test/system-prompt.md", import.meta.url).pathname),
	docs: path.join(new URL("../workflows/docs-agent/system-prompt.md", import.meta.url).pathname),
	steelman: path.join(new URL("../workflows/adversarial/steel-man-system-prompt.md", import.meta.url).pathname),
	contrarian: path.join(new URL("../workflows/adversarial/contrarian-system-prompt.md", import.meta.url).pathname),
};

/** Backward-compatible alias for the scout prompt path. */
export const SCOUT_SYSTEM_PROMPT_FILE = SPECIALIST_SYSTEM_PROMPT_FILES.scout;

/** Load the system prompt for a specialist (workflows/<specialist>/system-prompt.md). */
export function systemPromptFor(specialist: Specialist): string {
	return readFileSync(SPECIALIST_SYSTEM_PROMPT_FILES[specialist], "utf8");
}

/** The fenced-JSON RESULT contract restated to the model, per specialist. */
const RESULT_CONTRACT: Readonly<Record<Specialist, string[]>> = {
	scout: [
		'{ "objective": string, "verdict_stats": { "included": n, "summarized": n, "excluded": n, "unreachable": n },',
		'  "verdicts": [{"candidate": string, "verdict": "include"|"exclude"|"include-with-summary", "why": string}],',
		'  "findings": [{"claim": string, "citation": "path:line or URL+date", "confidence": "high"|"medium"|"low"|"single-source"}],',
		'  "gaps": [string],',
		'  "handoff": { "next_stage": "implement"|"verify"|"re-scout"|"report-to-user", "payload": string } }',
	],
	plan: [
		'{ "steps": [{"id": string, "action": string, "tool_role": string, "depends_on": [string], "done_when": string, "binds": string}],',
		'  "assumptions": [{"statement": string, "status": "unverified"|"verified"|"invalidated"}],',
		'  "parallel_groups": [string[]], "single_points_of_failure": [string] }',
	],
	build: [
		'{ "outcome": "green"|"unresolved", "changed_files": [string],',
		'  "verification_evidence": [{"check": string, "exit": number}], "lanes_used": [string], "notes": string }',
	],
	test: [
		'{ "verdicts": [{"testId": string, "class": "defect"|"flake"|"environment"|"pass"|"coverage_gap", "evidence": string}],',
		'  "first_attempt_pass_rate": number, "attested": [string], "not_attested": [string], "gaps": [string] }',
	],
	docs: [
		'{ "doc_updates": [{"path": string, "change": string, "evidence": [string], "risk": string}],',
		'  "claims_index_delta": [object], "release_notes": string,',
		'  "verdict": { "attested": [string], "stale_sections": [object] } }',
		'note: run-check folds into verdict — passing checks → attested; failing links/samples → stale_sections.',
	],
	steelman: [
		'{ "goal": string, "proposal": string, "premises": [{"claim": string, "basis": string}],',
		'  "preempted_objections": [object], "open_problems": [object] }',
		'OR { "structural_flag": { "reason": string } }',
	],
	contrarian: [
		'{ "verdict": "APPROVED" }',
		'OR { "verdict": "REJECTED", "fatal_flaws": [{"claim": string, "breaks": string, "why": string}] }',
		'OR { "verdict": "PROTOCOL_INVALID", "protocol_invalid_reason": "naive-draft"|"contamination" }',
	],
};

/** Restated RESULT contract lines for a specialist, used by PiRunner's prompt. */
export function resultContractHint(specialist: Specialist): string[] {
	return [...RESULT_CONTRACT[specialist]];
}

/** Options for PiRunner: the CLI knobs plus the workspace and the bound docs-check plan. */
export interface PiRunnerOptions {
	model?: string;
	timeoutMs?: number;
	systemPrompt?: string;
	/** repo root the live specialist runs in (defaults to the process cwd). */
	workspace?: string;
	/** the bindings/pi.yaml `agents.docs.roles.run-check` plan; defaults to the repo config. */
	docsCheck?: Partial<DocsCheckPlan>;
}

/** Resolve the docs `run-check` role as bound for this harness (bindings/pi.yaml). */
export function docsRunCheckPlan(workspace?: string, override?: Partial<DocsCheckPlan>): DocsCheckPlan {
	return resolveDocsCheckPlan(workspace ?? process.cwd(), override);
}

/**
 * Assemble the live Pi prompt for a dispatch. The docs specialist additionally gets its
 * bound `run-check` command, so the model can invoke the repo-configured docs check and
 * fold the result into `verdict.attested` / `verdict.stale_sections`.
 */
export function buildPiPrompt(
	dispatch: DispatchRecord,
	opts: { systemPrompt?: string; docsCheck?: Partial<DocsCheckPlan>; workspace?: string } = {},
): string {
	const systemPrompt = opts.systemPrompt ?? systemPromptFor(dispatch.specialist);
	const toolRoles: string[] = [];
	if (dispatch.specialist === "docs") {
		const plan = docsRunCheckPlan(opts.workspace, opts.docsCheck);
		const commandLine =
			plan.kind === "docs-ci"
				? "docs-ci (internal link checker + code-sample runner)"
				: [plan.command, ...(plan.args ?? [])].filter(Boolean).join(" ");
		toolRoles.push(
			"",
			"--- BOUND TOOL ROLES (workflows/bindings.md; capabilities, not prompt gates) ---",
			`run-check: ${commandLine}`,
			"Run the docs check before you submit. Passing checks satisfy verdict.attested;",
			"failing links/samples belong in verdict.stale_sections with the failing path/section.",
		);
	}
	// feed the contract + the dispatch as one prompt; the specialist reads the workspace itself
	return [
		systemPrompt,
		...toolRoles,
		"",
		`--- DISPATCH (you are the ${dispatch.specialist}; objective only, no meta) ---`,
		`OBJECTIVE: ${dispatch.input.goal}`,
		dispatch.input.constraints?.length ? `CONSTRAINTS: ${dispatch.input.constraints.join("; ")}` : "",
		dispatch.input.ledger_refs?.length ? `LEDGER REFS: ${dispatch.input.ledger_refs.join("; ")}` : "",
		dispatch.input.fatal_flaws?.length ? `FATAL FLAWS TO ADDRESS: ${dispatch.input.fatal_flaws.map((f) => f.claim).join("; ")}` : "",
		"",
		'OUTPUT REQUIREMENT: end your reply with one fenced ```json block — an object with EXACTLY',
		"these fields (schema-validated, all required):",
		...resultContractHint(dispatch.specialist),
	].filter(Boolean).join("\n");
}

/** Real model runner: local pi CLI (--mode json, no session) with the specialist contract. */
export class PiRunner implements SpecialistRunner {
	private readonly opts: PiRunnerOptions;
	/** tool-trace records for the roles this runner executes itself (docs `run-check`). */
	readonly toolTrace: ToolTraceRecord[] = [];

	constructor(opts: PiRunnerOptions = {}) {
		this.opts = opts;
	}

	/**
	 * Execute the bound docs `run-check` role against the runner's workspace and return the
	 * structured pass/fail result (`shared/docs-check.ts`). A live docs specialist uses this
	 * the same way the eval harness's `ToolRuntime.runCheck` does.
	 */
	runCheck({ timeoutMs }: { timeoutMs?: number } = {}): DocsCheckResult {
		const started = Date.now();
		try {
			const result = runDocsCheck(this.opts.workspace ?? process.cwd(), {
				plan: this.opts.docsCheck,
				timeoutMs,
			});
			this.toolTrace.push({
				ts: new Date().toISOString(),
				agent: "docs",
				role: "run-check",
				argsDigest: digest(result.source),
				outcome: result.outcome,
				durationMs: Date.now() - started,
			});
			return result;
		} catch (err) {
			this.toolTrace.push({
				ts: new Date().toISOString(),
				agent: "docs",
				role: "run-check",
				argsDigest: digest((err as Error).message),
				outcome: "error",
				durationMs: Date.now() - started,
			});
			throw err;
		}
	}

	async run(dispatch: DispatchRecord): Promise<unknown> {
		const prompt = buildPiPrompt(dispatch, this.opts);
		const argv = ["pi", "--mode", "json", "--no-session", "--"];
		if (this.opts.model) argv.splice(2, 0, "--provider", "ollama-cloud", "--model", this.opts.model);
		argv.push(prompt);
		const out = execFileSync(argv[0]!, argv.slice(1), {
			encoding: "utf8",
			timeout: this.opts.timeoutMs ?? 240_000,
			maxBuffer: 1 << 26,
			env: { ...process.env, PI_TELEMETRY: "0" },
		});
		// pi --mode json emits NDJSON events; take the last assistant text or the raw tail
		const texts: string[] = [];
		for (const line of out.split("\n")) {
			try {
				const ev = JSON.parse(line);
				const text = ev?.message?.content
					?.filter?.((c: { type?: string; text?: string }) => c?.type === "text")
					?.map((c: { text?: string }) => c.text ?? "").join("");
				if (text && ev?.message?.role === "assistant") texts.push(text);
			} catch { /* non-JSON line */ }
		}
		const reply = texts.join("\n\n") || out;
		const m = reply.match(/```json\n([\s\S]*?)```/);
		if (!m) throw new Error("no fenced JSON RESULT block in model output");
		return JSON.parse(m[1]!);
	}
}