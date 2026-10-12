import { piEventSchema, piOutcomeFromEvents, type PiEvent } from "../shared/pi-events";

import { type AgentCommand, CodingAgentSandbox, type TaskOutcome } from "../shared/sandbox";

export { default } from "../shared/handler";
export { Outbound } from "../shared/outbound";

export class PiSandbox extends CodingAgentSandbox {
	protected readonly agent = "pi";

	protected command(prompt: string): AgentCommand {
		return {
			argv: [
				"pi",
				"--mode",
				"json",
				"--no-session",
				"--provider",
				"ollama-cloud",
				"--model",
				this.env.MODEL,
				"--",
				prompt,
			],
			env: {
				// Pi requires a key; the Worker replaces this placeholder with the account key at the
				// egress boundary. PI_OFFLINE stays unset: it would suppress the catalog refresh that
				// resolves the model ID.
				OLLAMA_API_KEY: "provided-by-worker",
				// Reaches TypeSafe's Jev classifier through codemode, never as a chat model.
				TYPESAFE_API_KEY: "provided-by-worker",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
			},
		};
	}

	// Pi exits 0 even when the model call fails, so the outcome comes from its events:
	// the run must settle, and the last assistant message must not end in an error.
	// The classification itself lives in shared/pi-events.ts (pure, unit-tested).
	protected async outcome(exitCode: number): Promise<TaskOutcome> {
		if (exitCode !== 0) return this.exitFailure(exitCode);
		const events: PiEvent[] = [];
		for await (const event of this.events(piEventSchema)) events.push(event);
		return piOutcomeFromEvents(events);
	}
}