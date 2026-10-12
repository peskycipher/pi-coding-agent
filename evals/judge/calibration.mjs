// Judge calibration defaults (spec: workflows/test-eval-spec.md §4.2/§6).
//
// Thresholds + rotation for the prose judge in one place. `evals/config/models.yaml` mirrors
// this under `judge.calibration`; `judgeCalibrationFrom` reads that block and merges it over
// the defaults, so a partially-filled config still runs. The judge is tracked, never gating:
// these values decide when a run is flagged/healthy, never a scenario pass/fail.

export const DEFAULT_JUDGE_CALIBRATION = Object.freeze({
	rotation: Object.freeze({ runsPerReport: 2, offsets: Object.freeze([0, 1]) }),
	thresholds: Object.freeze({ disagreement: 1, healthyMean: 3.5, regressionDrop: 1.0 }),
});

function asNumber(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/** Merge a (possibly partial, snake_case or camelCase) calibration block over the defaults. */
export function normalizeJudgeCalibration(raw = {}) {
	const rotation = raw.rotation ?? {};
	const thresholds = raw.thresholds ?? {};
	const runsPerReport = Math.max(
		1,
		Math.trunc(asNumber(rotation.runs_per_report ?? rotation.runsPerReport, DEFAULT_JUDGE_CALIBRATION.rotation.runsPerReport)),
	);
	let offsets = Array.isArray(rotation.offsets) ? rotation.offsets.map(Number).filter(Number.isFinite) : [];
	if (offsets.length === 0) offsets = Array.from({ length: runsPerReport }, (_, i) => i);
	return {
		rotation: { runsPerReport, offsets },
		thresholds: {
			disagreement: asNumber(thresholds.disagreement, DEFAULT_JUDGE_CALIBRATION.thresholds.disagreement),
			healthyMean: asNumber(thresholds.healthy_mean ?? thresholds.healthyMean, DEFAULT_JUDGE_CALIBRATION.thresholds.healthyMean),
			regressionDrop: asNumber(thresholds.regression_drop ?? thresholds.regressionDrop, DEFAULT_JUDGE_CALIBRATION.thresholds.regressionDrop),
		},
	};
}

/** Read `judge.calibration` out of a parsed models.yaml document. */
export function judgeCalibrationFrom(modelsConfig) {
	return normalizeJudgeCalibration(modelsConfig?.judge?.calibration);
}
