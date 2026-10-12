import assert from "node:assert/strict";
import { test } from "node:test";

import type { PiEvent } from "../shared/pi-events.ts";
import { piEventSchema, piOutcomeFromEvents } from "../shared/pi-events.ts";

function settled(): unknown {
	return { type: "agent_settled" };
}

function messageEnd(stopReason: string, text: string, errorMessage?: string): unknown {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
	};
}

// The same filter PiSandbox.outcome applies before classifying.
function classify(exitCode: number, events: unknown[]) {
	const filtered = events
		.map((event) => piEventSchema.safeParse(event))
		.filter((result) => result.success)
		.map((result) => (result as { data: PiEvent }).data);
	return piOutcomeFromEvents(filtered);
}

test("a settled run with a final message succeeds", () => {
	assert.deepEqual(classify(0, [{ ignore: true }, messageEnd("stop", "done"), settled()]), {
		state: "succeeded",
		result: "done",
	});
});

test("a settled run keeps the last message_end as the result", () => {
	const outcome = classify(0, [
		messageEnd("stop", "first"),
		settled(),
		messageEnd("stop", "second"),
		settled(),
	]);
	assert.deepEqual(outcome, { state: "succeeded", result: "second" });
});

test("no settle means the run failed", () => {
	assert.deepEqual(classify(0, [messageEnd("stop", "done")]), {
		state: "failed",
		error: "pi exited before the agent settled",
	});
});

test("no final message means the run failed", () => {
	assert.deepEqual(classify(0, [settled()]), {
		state: "failed",
		error: "pi exited before the agent settled",
	});
});

test("an error stopReason fails with the reported error message", () => {
	assert.deepEqual(classify(0, [messageEnd("error", "", "model exploded"), settled()]), {
		state: "failed",
		error: "model exploded",
	});
});

test("an error stopReason without a message falls back to the stop reason", () => {
	assert.deepEqual(classify(0, [messageEnd("aborted", "partial work"), settled()]), {
		state: "failed",
		error: "pi stopped: aborted",
	});
});

test("malformed lines are ignored by the schema filter", () => {
	const outcome = classify(0, ["not json", { type: "message_end" }, messageEnd("stop", "ok"), settled()]);
	assert.deepEqual(outcome, { state: "succeeded", result: "ok" });
});

test("text blocks are joined and non-text blocks skipped", () => {
	const event = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "a" }, { type: "tool" }, { type: "text", text: "b" }],
			stopReason: "stop",
		},
	};
	assert.deepEqual(classify(0, [event, settled()]), { state: "succeeded", result: "ab" });
});