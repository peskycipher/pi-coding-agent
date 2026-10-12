// Specialist shim — tool-role implementations and SpecialistRunner bindings
// (workflows/bindings.md; evals tool-trace record per test-eval-spec.md §6).
//
// Increment 1: scout's read roles (glob, grep, read) execute for real against a
// workspace directory; runners:
//   - ScriptedRunner: deterministic RESULT payloads for tests/harness verification
//   - PiRunner: real model run via the local pi CLI (--mode json -- no session),
//     extracting the fenced-JSON RESULT block from the model output.
//
// Traces mirror evals/schemas/tool-trace.schema.json fields (args digests only).

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DispatchRecord, SpecialistRunner } from "./io.ts";

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

export const SCOUT_SYSTEM_PROMPT_FILE = path.join(new URL("../workflows/scout/system-prompt.md", import.meta.url).pathname);

/** Real model runner: local pi CLI (--mode json, no session) with the scout contract. */
export class PiRunner implements SpecialistRunner {
	private readonly opts: { model?: string; timeoutMs?: number };
	constructor(opts: { model?: string; timeoutMs?: number } = {}) {
		this.opts = opts;
	}
	async run(dispatch: DispatchRecord): Promise<unknown> {
		const systemPrompt = readFileSync(SCOUT_SYSTEM_PROMPT_FILE, "utf8");
		// feed the contract + the dispatch as one prompt; scout reads the workspace itself
		const prompt = [
			systemPrompt,
			"",
			"--- DISPATCH (you are the scout; objective only, no meta) ---",
			`OBJECTIVE: ${dispatch.input.goal}`,
			dispatch.input.constraints?.length ? `CONSTRAINTS: ${dispatch.input.constraints.join("; ")}` : "",
			"",
			'OUTPUT REQUIREMENT: end your reply with one fenced ```json block — an object with EXACTLY',
			"these fields (schema-validated, all required):",
			"{ \"objective\": string, \"verdict_stats\": { \"included\": n, \"summarized\": n, \"excluded\": n, \"unreachable\": n },",
			"  \"verdicts\": [{\"candidate\": string, \"verdict\": \"include\"|\"exclude\"|\"include-with-summary\", \"why\": string}],",
			"  \"findings\": [{\"claim\": string, \"citation\": \"path:line or URL+date\", \"confidence\": \"high\"|\"medium\"|\"low\"|\"single-source\"}],",
			"  \"gaps\": [string],",
			"  \"handoff\": { \"next_stage\": \"implement\"|\"verify\"|\"re-scout\"|\"report-to-user\", \"payload\": string } }",
		].filter(Boolean).join("\n");
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