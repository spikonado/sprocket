import type { highlightCode } from './code-highlighting';

type HighlightTokens = Awaited<ReturnType<typeof highlightCode>>;

export type HighlightRequest = { id: number; code: string; language: string };

export type HighlightResponse = { id: number; tokens: HighlightTokens };

let worker: Worker | undefined;

let nextId = 0;

const pending = new Map<
	number,
	{ request: HighlightRequest; resolve: (tokens: HighlightTokens) => void }
>();

let activeId: number | undefined;

function sendNext() {
	if (activeId !== undefined) return;

	const next = pending.values().next().value;

	if (!next) return;

	activeId = next.request.id;
	worker?.postMessage(next.request);
}

export function highlightCodeInWorker(code: string, language: string, signal: AbortSignal) {
	if (signal.aborted) return Promise.resolve(null);

	if (!worker) {
		worker = new Worker(new URL('./code-highlighting-worker.ts', import.meta.url), {
			type: 'module'
		});
		worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
			const { id, tokens } = event.data;
			pending.get(id)?.resolve(tokens);
			pending.delete(id);
			activeId = undefined;
			sendNext();
		};

		worker.onerror = () => {
			worker?.terminate();
			worker = undefined;
			activeId = undefined;

			for (const entry of pending.values()) entry.resolve(null);

			pending.clear();
		};
	}

	const id = nextId++;
	const request: HighlightRequest = { id, code, language };

	const result = new Promise<HighlightTokens>((resolve) => {
		const cancel = () => {
			pending.delete(id);
			resolve(null);
		};

		signal.addEventListener('abort', cancel, { once: true });
		pending.set(id, {
			request,
			resolve(tokens) {
				signal.removeEventListener('abort', cancel);
				resolve(tokens);
			}
		});
	});

	sendNext();

	return result;
}
