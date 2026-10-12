import { z } from "zod";

export const piEventSchema = z.union([
	z.object({ type: z.literal("agent_settled") }),
	z.object({
		type: z.literal("message_end"),
		message: z.object({
			role: z.literal("assistant"),
			content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
			stopReason: z.string(),
			errorMessage: z.string().optional(),
		}),
	}),
]);

export type PiEvent = z.infer<typeof piEventSchema>;

export type PiTaskOutcome =
	| { state: "succeeded"; result: string }
	| { state: "failed"; error: string };

// Pi exits 0 even when the model call fails, so the outcome comes from its events:
// the run must settle, and the last assistant message must not end in an error.
// Pure so `node --test` can check it without a Container.
export function piOutcomeFromEvents(events: PiEvent[]): PiTaskOutcome {
	let settled = false;
	let final: Extract<PiEvent, { type: "message_end" }>["message"] | undefined;
	for (const event of events) {
		if (event.type === "agent_settled") settled = true;
		else final = event.message;
	}
	if (!settled || final === undefined) {
		return { state: "failed", error: "pi exited before the agent settled" };
	}
	if (final.stopReason === "error" || final.stopReason === "aborted") {
		return { state: "failed", error: final.errorMessage ?? `pi stopped: ${final.stopReason}` };
	}
	const text = final.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []));
	return { state: "succeeded", result: text.join("") };
}