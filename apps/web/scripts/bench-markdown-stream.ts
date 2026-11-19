// Usage: bun scripts/bench-markdown-stream.ts
// Streams a chat answer in 3-12 character chunks and times each chat Markdown render.
import { readFileSync } from 'node:fs';
import { createMarkdownBlockRenderer } from '../src/lib/chat/markdown';

const answer = readFileSync(
	new URL('../src/lib/chat/fixtures/streamed-answer.md', import.meta.url),
	'utf8'
);

function chunkPrefixes(text: string) {
	let seed = 42;
	const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const prefixes: string[] = [];

	for (let length = 0; length < text.length;) {
		length = Math.min(text.length, length + 3 + Math.floor(random() * 10));
		prefixes.push(text.slice(0, length));
	}

	return prefixes;
}

function stream(prefixes: string[]) {
	const render = createMarkdownBlockRenderer();
	const ids = new Set<string>();

	for (const prefix of prefixes) render(prefix, ids);
}

for (const text of [answer, Array(4).fill(answer).join('\n\n')]) {
	const prefixes = chunkPrefixes(text);
	stream(prefixes);
	const runs: number[] = [];

	for (let run = 0; run < 7; run++) {
		const start = performance.now();
		stream(prefixes);
		runs.push(performance.now() - start);
	}

	const median = runs.sort((a, b) => a - b)[3];

	console.log(
		`${(text.length / 1000).toFixed(1)} KB: ${prefixes.length} chunks, ${(median / prefixes.length).toFixed(3)} ms per chunk`
	);
}
