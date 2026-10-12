// LLM judge harness (spec: workflows/test-eval-spec.md §4.2/A10).
//
// Prose quality only, pointwise, blind to mechanical scores, double-run with rotation,
// disagreement > 1 point flags for human audit. Never merges into pass/fail — the judge
// result is recorded beside the mechanical result.
//
// The model call is injected (`callModel`) so the harness and its tests stay offline; the
// single permitted outbound call lives in `resolveJudgeCaller` and reads its endpoint/key
// from the environment.

import { readFileSync } from "node:fs";

import { DEFAULT_JUDGE_CALIBRATION, normalizeJudgeCalibration } from "./calibration.mjs";

export const JUDGE_PROMPT_VERSION = "judge-prompt-v1";

const PROMPT_MD = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");

/** Extract the versioned system prompt from the first fenced text block of prompt.md. */
export function loadSystemPrompt() {
	const m = PROMPT_MD.match(/```text\n([\s\S]*?)\n```/);
	if (!m) throw new Error("judge/prompt.md is missing its fenced system prompt block");
	return m[1];
}

export const SYSTEM_PROMPT = loadSystemPrompt();

export const TEST_DIMENSIONS = ["report_actionability", "verdict_precision"];
export const DOCS_DIMENSIONS = ["report_actionability", "verdict_precision", "doc_update_register"];

const DIMENSION_GUIDANCE = {
	report_actionability:
		"Does the RUN REPORT let a human act in one pass? Weigh evidence-pack completeness, ordering, and absence of padding.",
	verdict_precision:
		"Does the verdict block claim only what the scope supports? Weigh attested/not-attested/gaps precision and whether green is scoped.",
	doc_update_register:
		"Does the doc update read in the right register and stay anchored? User-facing prose must be plain and internals-free; developer-facing text must be precise; confidence must come from anchors, not authority.",
};

/** Build the judge messages for one dimension. `rotation` swaps the two context blocks. */
export function buildJudgeMessages({ dimension, reportText, manifestContext = {}, rotation = 0 } = {}) {
	if (!DIMENSION_GUIDANCE[dimension]) throw new Error(`unknown judge dimension: ${dimension}`);
	const report = `[RUN REPORT]\n${reportText ?? ""}`;
	const context = `[SCENARIO CONTEXT]\n${JSON.stringify(manifestContext, null, 2)}`;
	const blocks = rotation % 2 === 0 ? [report, context] : [context, report];
	const user = [
		`DIMENSION: ${dimension}`,
		DIMENSION_GUIDANCE[dimension],
		"",
		...blocks,
		"",
		"Score this dimension only. Reply with SCORE: <1-5> and REASON: <one sentence>.",
	].join("\n");
	return [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: user },
	];
}

/** Parse the judge's integer score (1-5) from a raw model response. */
export function parseScore(text) {
	const scored = String(text ?? "").match(/SCORE:\s*([1-5])\b/i);
	if (scored) return Number(scored[1]);
	const any = String(text ?? "").match(/\b([1-5])\b/);
	return any ? Number(any[1]) : null;
}

function parseReason(text) {
	const m = String(text ?? "").match(/REASON:\s*(.+)/i);
	return m ? m[1].trim() : "";
}

/**
 * Score one artifact. `callModel({messages, model, temperature, dimension, rotation})`
 * returns the raw model text. Runs `calibration.rotation.offsets` times per dimension (the
 * spec default is two, order-swapped); a spread greater than `thresholds.disagreement`
 * flags the dimension. Returns a tracked result — it never gates.
 */
export async function runJudge({
	reportText,
	manifestContext = {},
	agent = "test",
	callModel,
	model = "judge",
	dimensions,
	calibration = DEFAULT_JUDGE_CALIBRATION,
} = {}) {
	if (typeof callModel !== "function") throw new Error("runJudge requires a callModel function");
	const cal = normalizeJudgeCalibration(calibration);
	const dims = dimensions ?? (agent === "docs" ? DOCS_DIMENSIONS : TEST_DIMENSIONS);
	const results = {};
	const flags = [];
	for (const dimension of dims) {
		const runs = [];
		for (const rotation of cal.rotation.offsets) {
			const messages = buildJudgeMessages({ dimension, reportText, manifestContext, rotation });
			const raw = await callModel({ messages, model, temperature: 0, dimension, rotation });
			runs.push({ rotation, score: parseScore(raw), reason: parseReason(raw) });
		}
		const values = runs.map((r) => r.score).filter((v) => typeof v === "number");
		const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
		const spread = values.length >= 2 ? Math.max(...values) - Math.min(...values) : 0;
		const flagged = values.length === runs.length && spread > cal.thresholds.disagreement;
		if (flagged) flags.push(dimension);
		results[dimension] = { runs, mean, flagged };
	}
	const means = Object.values(results)
		.map((r) => r.mean)
		.filter((v) => typeof v === "number");
	const overall = means.length ? means.reduce((a, b) => a + b, 0) / means.length : null;
	return {
		version: JUDGE_PROMPT_VERSION,
		model,
		agent,
		dimensions: results,
		mean: overall,
		healthy: overall === null ? null : overall >= cal.thresholds.healthyMean,
		flags,
		calibration: cal,
	};
}

/**
 * Default outbound model caller. Enabled only when `EVAL_JUDGE_URL` is set (A4: judge
 * calls are the single permitted outbound; key from env). Returns null when unconfigured so
 * `eval:core` never reaches for the network.
 */
export function resolveJudgeCaller({ env = process.env } = {}) {
	const url = env.EVAL_JUDGE_URL;
	if (!url) return null;
	const apiKey = env.EVAL_JUDGE_API_KEY ?? env.OLLAMA_API_KEY ?? "";
	return async ({ messages, model, temperature = 0 }) => {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
			body: JSON.stringify({ model, messages, temperature }),
		});
		if (!res.ok) throw new Error(`judge call failed: HTTP ${res.status}`);
		const data = await res.json();
		return data.choices?.[0]?.message?.content ?? data.response ?? data.content ?? "";
	};
}
