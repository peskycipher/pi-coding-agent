import assert from "node:assert/strict";
import { test } from "node:test";

import { loadYamlFile } from "../evals/harness/config.mjs";
import {
	DEFAULT_JUDGE_CALIBRATION,
	judgeCalibrationFrom,
	normalizeJudgeCalibration,
} from "../evals/judge/calibration.mjs";
import { runJudge } from "../evals/judge/judge.mjs";
import { ROOT } from "../evals/harness/run.mjs";
import path from "node:path";

test("judge calibration defaults declare thresholds and rotation", () => {
	assert.equal(DEFAULT_JUDGE_CALIBRATION.rotation.runsPerReport, 2);
	assert.deepEqual([...DEFAULT_JUDGE_CALIBRATION.rotation.offsets], [0, 1]);
	assert.deepEqual(DEFAULT_JUDGE_CALIBRATION.thresholds, { disagreement: 1, healthyMean: 3.5, regressionDrop: 1.0 });
});

test("normalizeJudgeCalibration fills missing fields from the defaults", () => {
	const same = normalizeJudgeCalibration({});
	assert.deepEqual(same.thresholds, { ...DEFAULT_JUDGE_CALIBRATION.thresholds });
	assert.deepEqual(same.rotation.offsets, [0, 1]);
	const custom = normalizeJudgeCalibration({
		rotation: { runs_per_report: 3, offsets: [0, 1, 2] },
		thresholds: { healthy_mean: 4, disagreement: 0, regression_drop: 0.5 },
	});
	assert.equal(custom.rotation.runsPerReport, 3);
	assert.deepEqual(custom.rotation.offsets, [0, 1, 2]);
	assert.deepEqual(custom.thresholds, { disagreement: 0, healthyMean: 4, regressionDrop: 0.5 });
});

test("models.yaml judge calibration mirrors the code defaults (anchors resolved)", () => {
	const models = loadYamlFile(path.join(ROOT, "evals/config/models.yaml"));
	const cal = judgeCalibrationFrom(models);
	assert.deepEqual(cal.thresholds, { disagreement: 1, healthyMean: 3.5, regressionDrop: 1.0 });
	assert.equal(cal.rotation.runsPerReport, 2);
	assert.deepEqual(cal.rotation.offsets, [0, 1]);
	// the pre-calibration flat fields alias the same values
	assert.equal(models.judge.healthy_mean, cal.thresholds.healthyMean);
	assert.equal(models.judge.disagreement_threshold, cal.thresholds.disagreement);
	assert.equal(models.judge.regression_drop, cal.thresholds.regressionDrop);
	assert.equal(models.judge.runs_per_report, cal.rotation.runsPerReport);
});

test("runJudge honors a calibrated healthy threshold and rotation", async () => {
	const calls = [];
	const callModel = async ({ rotation }) => {
		calls.push(rotation);
		return "SCORE: 4";
	};
	const strict = await runJudge({
		reportText: "r",
		callModel,
		dimensions: ["verdict_precision"],
		calibration: { thresholds: { healthy_mean: 4.5 } },
	});
	assert.equal(strict.mean, 4);
	assert.equal(strict.healthy, false);
	assert.deepEqual(calls, [0, 1]);

	calls.length = 0;
	const triple = await runJudge({
		reportText: "r",
		callModel,
		dimensions: ["verdict_precision"],
		calibration: { rotation: { runs_per_report: 3, offsets: [0, 1, 2] } },
	});
	assert.equal(triple.dimensions.verdict_precision.runs.length, 3);
	assert.deepEqual(calls, [0, 1, 2]);
});

test("runJudge disagreement threshold is calibratable", async () => {
	let n = 0;
	const callModel = async () => (n++ === 0 ? "SCORE: 5" : "SCORE: 4");
	const strict = await runJudge({
		reportText: "r",
		callModel,
		dimensions: ["verdict_precision"],
		calibration: { thresholds: { disagreement: 0 } },
	});
	assert.deepEqual(strict.flags, ["verdict_precision"]);
});
