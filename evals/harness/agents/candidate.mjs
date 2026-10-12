// Real candidate adapters for the eval suite (spec: workflows/test-eval-spec.md §1/A2).
//
// A candidate is prompt/workflow text (see `candidates:` in evals/config/models.yaml) hosted
// on a model from the matrix. This module turns that text into an agent adapter the eval
// dispatcher can call: it assembles the candidate prompt + its RESULT contract (from
// shared/shim.ts — the single source for specialist prompts and contracts), runs a bounded
// model→tool→observation loop against the ToolRuntime the dispatcher provisioned, and
// returns the candidate's RESULT payload for dispatcher validation.
//
// The model call is injected (`callModel`) so the harness and its tests stay offline.
// `resolveCandidateCaller` is the only place a real model call is configured: an HTTP
// endpoint (`EVAL_MODEL_URL`) or a local CLI (`EVAL_MODEL_CLI`, e.g. `pi`); it is inert
// when neither is set, mirroring the judge caller. Candidate runs are model calls, not the
// judge's prose call — spec §8 Q1 still owns the matrix IDs and budget.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadYamlFile } from "../config.mjs";
import { resultContractHint, systemPromptFor } from "../../../shared/shim.ts";

const execFileAsync = promisify(execFile);

export const ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/** Default bound on model↔tool turns before the adapter gives up honestly. */
export const DEFAULT_MAX_STEPS = 12;

/** Tool roles per specialist, mirroring the workflow tables and ToolRuntime methods. */
export const TOOL_ROLES = {
	test: ["env-check", "run-suite", "run-test", "read-log", "workspace-read", "git-info", "test-edit", "notify"],
	docs: ["run-check", "read-log", "workspace-read", "git-info", "docs-edit", "notify"],
};

/** role name → ToolRuntime method name. */
const ROLE_METHODS = {
	"env-check": "envCheck",
	"run-suite": "runSuite",
	"run-test": "runTest",
	"read-log": "readLog",
	"workspace-read": "workspaceRead",
	"git-info": "gitInfo",
	"test-edit": "testEdit",
	"docs-edit": "docsEdit",
	"run-check": "runCheck",
	notify: "notify",
};

export class CandidateError extends Error {
	constructor(message) {
		super(message);
		this.name = "CandidateError";
	}
}

/** Candidate entries from models.yaml, defaulting the agent mapping from the id. */
export function candidateDefinitions(root = ROOT) {
	const models = loadYamlFile(path.join(root, "evals/config/models.yaml"));
	return (models.candidates ?? []).map((c) => ({
		...c,
		agent: c.agent ?? (String(c.id).startsWith("docs") ? "docs" : "test"),
	}));
}

/** The operative prompt block from a candidate markdown file (fenced text block), else the file. */
export function extractPromptBlock(markdown) {
	const m = String(markdown ?? "").match(/```text\n([\s\S]*?)\n```/);
	return m ? m[1] : String(markdown ?? "");
}

/** Load a candidate's prompt and reference (workflow/design) text from the repo root. */
export function loadCandidateText(root, candidate) {
	const read = (rel, fallback = "") => {
		if (!rel) return fallback;
		try {
			return readFileSync(path.resolve(root, rel), "utf8");
		} catch (err) {
			throw new CandidateError(`candidate ${candidate?.id ?? "?"}: cannot read ${rel} (${err.message})`);
		}
	};
	const promptFile = candidate.prompt ?? candidate.system_prompt;
	const prompt = promptFile ? extractPromptBlock(read(promptFile)) : systemPromptFor(candidate.agent);
	const reference = read(candidate.workflow ?? candidate.design, "");
	return { prompt, reference };
}

/** The harness tool protocol the candidate must speak to drive ToolRuntime. */
export function toolProtocol(agent) {
	const roles = TOOL_ROLES[agent] ?? TOOL_ROLES.test;
	return [
		"You are running under the evaluation harness. Drive it by replying with exactly one",
		"fenced ```json block per turn — either a tool call or the final result.",
		"",
		'Tool call:  {"tool": "<role>", "args": { ... }}',
		'Final:      {"result": { <the RESULT contract fields below> }}',
		"",
		"Available roles and args:",
		'- env-check        {"runner": "<jest|pytest>", "checks": [{"name","command","args","required"}]}',
		'- run-suite        {"target": "full" | "<test path/name>"}',
		'- run-test         {"target": "<test path/name>"}',
		'- read-log         {"path": "<workspace-relative>", "tail": <n>}',
		'- workspace-read   {"op": "glob|grep|read", "glob"|"pattern"|"path": "..."}',
		'- git-info         {"args": ["log", "-1"]}   (read-only verbs only)',
		'- test-edit        {"path": "<test code>", "content": "<new text>"}',
		'- docs-edit        {"path": "<docs/**>", "content": "<new text>"}',
		'- run-check        {"command": "<docs check>", "args": [...]}',
		'- notify           {"kind": "report", "body": "<human report>", ...}',
		"",
		`The bound runner is supplied by the harness; the permitted roles for this dispatch are: ${roles.join(", ")}.`,
		"Use notify for the run report (and quarantine proposals); the RESULT is the machine-checked object.",
	].join("\n");
}

/** Assemble the candidate system prompt: prompt + reference + tool protocol + result contract. */
export function buildCandidateSystemPrompt({ candidate, agent, texts }) {
	if (!texts?.prompt) throw new CandidateError("buildCandidateSystemPrompt requires candidate text");
	return [
		texts.prompt,
		texts.reference
			? `\n\n---\n\n## Reference workflow (authoritative on any divergence)\n\n${texts.reference}`
			: "",
		`\n\n---\n\n## Eval harness tool protocol\n\n${toolProtocol(agent)}`,
		`\n\n## RESULT contract (schema-validated — all fields required)\n\n${resultContractHint(agent).join("\n")}`,
	].join("");
}

/** Build the initial model messages: system (candidate) + user (the DISPATCH). */
export function buildCandidateMessages({ dispatch, agent, runner, candidate, texts }) {
	if (!dispatch) throw new CandidateError("buildCandidateMessages requires a dispatch");
	return [
		{ role: "system", content: buildCandidateSystemPrompt({ candidate, agent, texts }) },
		{
			role: "user",
			content: [
				"## DISPATCH",
				`dispatch_id: ${dispatch.dispatch_id}`,
				`specialist: ${dispatch.specialist}`,
				`task_ref: ${dispatch.task_ref}`,
				`objective: ${dispatch.input?.goal ?? ""}`,
				`instruction: ${dispatch.instruction ?? ""}`,
				`bound_runner: ${runner ?? "(unspecified)"}`,
				`requires_tools: ${(dispatch.requires_tools ?? []).join(", ")}`,
				`budget: ${dispatch.budget?.tool_calls ?? "?"} tool calls / ${dispatch.budget?.seconds ?? "?"} s`,
				...(dispatch.input?.retry === "fresh" ? ["retry: fresh — the previous RESULT was not contract-valid; re-output it."] : []),
				"",
				"Begin. Reply with one fenced json block: a tool call, or the final result once you have enough evidence.",
			].join("\n"),
		},
	];
}

/** Extract and parse the single fenced json block (or a bare JSON object) from a model turn. */
export function extractJsonBlock(text) {
	const match = String(text ?? "").match(/```json\s*\n([\s\S]*?)```/);
	if (match) {
		try {
			return JSON.parse(match[1]);
		} catch {
			/* fall through to the bare-object attempt */
		}
	}
	const trimmed = String(text ?? "").trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return null;
		}
	}
	return null;
}

function looksLikeResult(obj, agent) {
	const keys = agent === "docs"
		? ["doc_updates", "release_notes", "claims_index_delta", "verdict"]
		: ["verdicts", "first_attempt_pass_rate", "attested", "not_attested", "gaps"];
	return keys.some((k) => k in obj);
}

/** Normalize a model turn into `{kind:"tool", tool, args}` or `{kind:"result", result}`, else null. */
export function parseAction(text, agent = "test") {
	const obj = extractJsonBlock(text);
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
	if (typeof obj.tool === "string") return { kind: "tool", tool: obj.tool, args: obj.args ?? {} };
	if (obj.result !== undefined && typeof obj.result === "object") return { kind: "result", result: obj.result };
	if (looksLikeResult(obj, agent)) return { kind: "result", result: obj };
	return null;
}

function tail(text, max = 4000) {
	const s = String(text ?? "");
	return s.length > max ? s.slice(s.length - max) : s;
}

/** Trim a raw tool result to what the model needs, without dumping unbounded output. */
export function compactObservation(result) {
	if (result === null || result === undefined || typeof result !== "object") {
		return { outcome: "ok", result: result ?? null };
	}
	const out = { outcome: result.outcome ?? "ok" };
	if (result.exitCode !== undefined) out.exitCode = result.exitCode;
	if (result.error !== undefined) out.error = result.error;
	if (result.gaps !== undefined) out.gaps = result.gaps;
	if (result.files !== undefined) out.files = result.files;
	if (result.diff !== undefined) out.diff = String(result.diff).slice(0, 2000);
	if (result.hits !== undefined) out.hits = result.hits.slice(0, 50);
	if (result.text !== undefined) out.text = tail(result.text);
	if (result.stdout !== undefined) out.stdout = tail(result.stdout);
	if (result.stderr !== undefined) out.stderr = tail(result.stderr);
	if (result.payload !== undefined) out.payload = result.payload;
	return out;
}

/**
 * Execute one parsed tool action through the dispatcher's ToolRuntime. A missing role
 * binding is returned as an error observation (never thrown) so the model can adapt; the
 * runtime itself still enforces the path jail and the budget.
 */
export async function executeTool(runtime, action, { runner } = {}) {
	const method = ROLE_METHODS[action.tool];
	if (!method) return { outcome: "error", error: `unknown tool role: ${action.tool}` };
	if (typeof runtime[method] !== "function") {
		return { outcome: "error", error: `${action.tool} is not bound in this harness` };
	}
	const args = { ...(action.args ?? {}) };
	if ((action.tool === "run-suite" || action.tool === "run-test") && args.runner === undefined && runner) {
		args.runner = runner;
	}
	const result = await runtime[method](args);
	return compactObservation(result);
}

/**
 * Build a candidate adapter `({dispatch, runtime, runner, scenario}) => RESULT`.
 * `callModel({messages, model, temperature, dispatch, step})` returns the model's raw text.
 */
export function createCandidateAdapter({
	candidate,
	callModel,
	model = "candidate",
	maxSteps = DEFAULT_MAX_STEPS,
	root = ROOT,
	texts,
} = {}) {
	if (!candidate || !candidate.agent) throw new CandidateError("createCandidateAdapter requires a candidate with an agent");
	if (typeof callModel !== "function") throw new CandidateError("createCandidateAdapter requires a callModel function");
	const loaded = texts ?? loadCandidateText(root, candidate);
	return async function candidateAgent({ dispatch, runtime, runner }) {
		const messages = buildCandidateMessages({ dispatch, agent: candidate.agent, runner, candidate, texts: loaded });
		for (let step = 0; step < maxSteps; step++) {
			const raw = await callModel({ messages: [...messages], model, temperature: 0, dispatch, step, agent: candidate.agent });
			const action = parseAction(raw, candidate.agent);
			if (action?.kind === "result") return action.result;

			messages.push({ role: "assistant", content: typeof raw === "string" ? raw : JSON.stringify(raw) });
			if (action?.kind === "tool") {
				let observation;
				try {
					observation = await executeTool(runtime, action, { runner });
				} catch (err) {
					observation = { outcome: "error", error: err.message };
				}
				messages.push({
					role: "user",
					content: `[TOOL RESULT ${action.tool}]\n${JSON.stringify(observation)}`,
				});
			} else {
				messages.push({
					role: "user",
					content: 'No json block found. Reply with exactly one fenced json block: a tool call {"tool": "...", "args": {...}} or the final {"result": {...}}.',
				});
			}
		}
		throw new CandidateError(`candidate ${candidate.id} produced no RESULT after ${maxSteps} steps`);
	};
}

/**
 * Build one adapter for a whole run: the candidate is selected per scenario by its
 * specialist, so `eval:core` (test + docs scenarios) routes each dispatch to the right
 * prompt. `callModel` is shared across candidates.
 */
export function createCandidateSuiteAdapter({ root = ROOT, callModel, model, maxSteps = DEFAULT_MAX_STEPS } = {}) {
	const byAgent = {};
	for (const candidate of candidateDefinitions(root)) byAgent[candidate.agent] = candidate;
	const adapters = {};
	for (const [agent, candidate] of Object.entries(byAgent)) {
		adapters[agent] = createCandidateAdapter({ candidate, callModel, model, maxSteps, root });
	}
	return async function candidateSuiteAgent(ctx) {
		const agent = ctx?.scenario?.agent ?? ctx?.dispatch?.specialist;
		const adapter = adapters[agent];
		if (!adapter) throw new CandidateError(`no candidate is configured for agent "${agent}"`);
		return adapter(ctx);
	};
}

// ---------- real model callers ----------

/** Serialize a message list for a CLI chat call (the CLI keeps no session across turns). */
export function serializeMessages(messages) {
	return (messages ?? []).map((m) => `### ${m.role}\n${m.content}`).join("\n\n");
}

function lastAssistantText(ndjson) {
	const texts = [];
	for (const line of String(ndjson ?? "").split("\n")) {
		try {
			const ev = JSON.parse(line);
			const text = ev?.message?.content
				?.filter?.((c) => c?.type === "text")
				?.map((c) => c.text ?? "")
				.join("");
			if (text && ev?.message?.role === "assistant") texts.push(text);
		} catch {
			/* non-JSON line */
		}
	}
	return texts.length ? texts.join("\n\n") : null;
}

/** A caller that shells out to a local agent CLI (`pi --mode json --no-session`). */
export function createCliCaller({ command = "pi", env = process.env, timeoutMs = 240_000, provider } = {}) {
	return async ({ messages, model }) => {
		const args = ["--mode", "json", "--no-session"];
		const providerName = provider ?? env.EVAL_MODEL_PROVIDER;
		if (providerName) args.push("--provider", providerName);
		// Do not forward an unresolved matrix placeholder (spec §8 Q1); let the CLI use its
		// configured default model rather than failing on an owner-to-fill id.
		const usableModel = model && !String(model).startsWith("owner-to-fill") ? model : null;
		if (usableModel) args.push("--model", usableModel);
		args.push("--", serializeMessages(messages));
		const { stdout } = await execFileAsync(command, args, {
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 1 << 26,
			env: { ...env, PI_TELEMETRY: "0" },
		});
		return lastAssistantText(stdout) ?? stdout;
	};
}

/**
 * Resolve the candidate model caller: an HTTP endpoint (`EVAL_MODEL_URL`) or a local CLI
 * (`EVAL_MODEL_CLI`). Returns null when neither is configured, so offline harness paths
 * never reach for a model. This is deliberately separate from the judge caller.
 *
 * TODO(spec §8 Q1/Q2 — owner decision pending): the endpoint/provider/model budget is not
 * chosen, so no default URL or model id is invented here.
 */
export function resolveCandidateCaller({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
	const url = env.EVAL_MODEL_URL;
	if (url) {
		const apiKey = env.EVAL_MODEL_API_KEY ?? env.OLLAMA_API_KEY ?? "";
		return async ({ messages, model, temperature = 0 }) => {
			const res = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
				body: JSON.stringify({ model, messages, temperature }),
			});
			if (!res.ok) throw new CandidateError(`model call failed: HTTP ${res.status}`);
			const data = await res.json();
			return data.choices?.[0]?.message?.content ?? data.response ?? data.content ?? "";
		};
	}
	const command = env.EVAL_MODEL_CLI;
	if (command) {
		return createCliCaller({
			command,
			env,
			provider: env.EVAL_MODEL_PROVIDER,
			timeoutMs: env.EVAL_MODEL_TIMEOUT_MS ? Number(env.EVAL_MODEL_TIMEOUT_MS) : undefined,
		});
	}
	return null;
}
