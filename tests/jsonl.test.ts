import assert from "node:assert/strict";
import { test } from "node:test";

import { readLines } from "../shared/jsonl.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function all(body: ReadableStream<Uint8Array> | null): Promise<string[]> {
	const lines: string[] = [];
	for await (const line of readLines(body)) lines.push(line);
	return lines;
}

test("readLines splits lines across chunk boundaries", async () => {
	const lines = await all(streamOf(['{"a":1}\n{"b":2}\n{"c', '":3}\n']));
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("readLines yields a final line without a newline", async () => {
	assert.deepEqual(await all(streamOf("one\ntwo")), ["one", "two"]);
});

test("readLines yields nothing for an empty stream", async () => {
	// An empty byte chunk makes no line; a whitespace-only final line does.
	assert.deepEqual(await all(streamOf([""])), []);
	assert.deepEqual(await all(streamOf([" "])), [" "]);
	assert.deepEqual(await all(streamOf([])), []);
});

test("readLines does not split multibyte characters across chunks", async () => {
	const lines = await all(streamOf(["aé", "b\n"]));
	assert.deepEqual(lines, ["aéb"]);
});

test("readLines with a null body yields nothing", async () => {
	assert.deepEqual(await all(null), []);
});