import { afterEach, expect, it, vi } from 'vitest';
import {
	highlightCodeInWorker,
	type HighlightRequest,
	type HighlightResponse
} from './code-highlighting-client';

afterEach(() => vi.unstubAllGlobals());

it('keeps only the current queued request while a previous highlight is running', async () => {
	const sent: HighlightRequest[] = [];
	let reply: (id: number) => void = () => {};

	vi.stubGlobal(
		'Worker',
		class {
			onmessage?: (event: MessageEvent<HighlightResponse>) => void;
			constructor() {
				reply = (id) => this.onmessage?.(new MessageEvent('message', { data: { id, tokens: [] } }));
			}
			postMessage(request: HighlightRequest) {
				sent.push(request);
			}
		}
	);
	const first = new AbortController();
	const firstResult = highlightCodeInWorker('const', 'js', first.signal);
	first.abort();

	for (let index = 0; index < 20; index++) {
		const controller = new AbortController();
		const result = highlightCodeInWorker(`const reading = ${index}`, 'js', controller.signal);
		controller.abort();
		expect(await result).toBeNull();
	}

	const latest = highlightCodeInWorker('const reading = 23.4;', 'js', new AbortController().signal);
	expect(sent).toHaveLength(1);
	expect(await firstResult).toBeNull();
	reply(sent[0]!.id);
	expect(sent.map((request) => request.code)).toEqual(['const', 'const reading = 23.4;']);
	reply(sent[1]!.id);
	expect(await latest).toEqual([]);
});
