import type { highlightCode } from './code-highlighting';

type HighlightTokens = Awaited<ReturnType<typeof highlightCode>>;

export type HighlightRequest = { id: number; code: string; language: string };

export type HighlightResponse = { id: number; tokens: HighlightTokens };

let worker: Worker | undefined;

let nextId = 0;

const pending = new Map<number, (tokens: HighlightTokens) => void>();

export function highlightCodeInWorker(code: string, language: string) {
	if (!worker) {
		worker = new Worker(new URL('./code-highlighting-worker.ts', import.meta.url), {
			type: 'module'
		});
		worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
			const { id, tokens } = event.data;
			pending.get(id)?.(tokens);
			pending.delete(id);
		};

		worker.onerror = () => {
			worker?.terminate();
			worker = undefined;

			for (const resolve of pending.values()) resolve(null);

			pending.clear();
		};
	}

	const id = nextId++;
	const request: HighlightRequest = { id, code, language };
	const result = new Promise<HighlightTokens>((resolve) => pending.set(id, resolve));
	worker.postMessage(request);

	return result;
}
