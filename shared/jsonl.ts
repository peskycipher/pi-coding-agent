// Splits a binary stream into lines without buffering it whole.
export async function* readLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
	if (body === null) return;
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of body) {
		buffered += decoder.decode(chunk, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		yield* lines;
	}
	buffered += decoder.decode();
	if (buffered !== "") yield buffered;
}