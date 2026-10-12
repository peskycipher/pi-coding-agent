// Deterministic smoke agent for the eval harness.
//
// This is NOT an evaluation candidate — it exists so `npm run eval:core` and the harness
// tests can drive the real tool roles end to end and produce schema-valid RESULTs offline.
// Wiring the actual prompt/workflow candidates and model matrix is a remaining item
// (evals/config/models.yaml placeholders, spec §8 Q1).

export async function run({ dispatch, runtime, runner = "jest" }) {
	if (dispatch.specialist === "docs") {
		await runtime.workspaceRead({ op: "glob", glob: "docs/**/*.md" });
		await runtime.notify({
			kind: "report",
			body: "Trigger: nightly sweep\nStale claims: none\nHealthy coverage: 0\nReview class: cosmetic",
		});
		return {
			doc_updates: [],
			claims_index_delta: [],
			verdict: { attested: [], stale_sections: [] },
		};
	}
	await runtime.envCheck({ runner });
	const res = await runtime.runSuite({ runner, target: "full" });
	const pass = res.outcome === "ok";
	await runtime.notify({
		kind: "report",
		body: `Result: full @ HEAD — ${pass ? "pass" : "fail"} — selection rule: full\nFirst-attempt pass rate: ${pass ? 100 : 0}%`,
	});
	return {
		verdicts: [],
		first_attempt_pass_rate: pass ? 1 : 0,
		attested: pass ? ["harness/scaffolding worked"] : [],
		not_attested: [],
		gaps: pass ? [] : ["suite failed"],
	};
}

export default run;
