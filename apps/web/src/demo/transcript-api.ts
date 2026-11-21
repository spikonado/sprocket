import type { TranscriptStoreApi } from '$lib/home/transcript-store';
import type {
	TranscriptEvent,
	TranscriptRow,
	TranscriptSnapshot,
	WatchHandlers
} from '$lib/types/sprocket';
import type { TranscriptFixture } from './fixtures/types';

type Listener = (event: TranscriptEvent) => void;

function snapshot(rows: TranscriptRow[]): TranscriptSnapshot {
	return { type: 'snapshot', rows, nextBefore: null, stale: false };
}

/** Serves transcripts from memory the way the local server streams them, so the real store renders them. */
export class DemoTranscripts implements TranscriptStoreApi {
	#threads = new Map<string, TranscriptFixture>();
	#listeners = new Map<string, Set<Listener>>();

	constructor(fixtures: Record<string, TranscriptFixture>) {
		for (const [threadId, fixture] of Object.entries(fixtures)) {
			this.#threads.set(threadId, structuredClone(fixture));
		}
	}

	fetchTranscriptRows: TranscriptStoreApi['fetchTranscriptRows'] = async () => snapshot([]);

	fetchTranscriptRow: TranscriptStoreApi['fetchTranscriptRow'] = async ({ threadId, rowId }) => {
		const row = this.#detail(threadId, rowId);

		if (!row) throw new Error(`Unknown transcript row ${rowId}.`);

		return { row };
	};

	watchTranscript: TranscriptStoreApi['watchTranscript'] = ({ threadId }, handlers) =>
		this.#watch(`thread:${threadId}`, () => this.#thread(threadId).rows, handlers);

	watchTranscriptWork: TranscriptStoreApi['watchTranscriptWork'] = (
		{ threadId, rowId },
		handlers
	) =>
		this.#watch(
			`work:${threadId}:${rowId}`,
			() => this.#thread(threadId).work[rowId] ?? [],
			handlers
		);

	watchTranscriptItem: TranscriptStoreApi['watchTranscriptItem'] = (
		{ threadId, rowId },
		handlers
	) =>
		this.#watch(
			`item:${threadId}:${rowId}`,
			() => [this.#detail(threadId, rowId)].filter((row) => row !== undefined),
			handlers
		);

	putRow(threadId: string, row: TranscriptRow) {
		const rows = this.#thread(threadId).rows;
		const index = rows.findIndex((candidate) => candidate.id === row.id);

		if (index === -1) rows.push(row);
		else rows[index] = row;
		this.#emit(`thread:${threadId}`, { type: 'row', row });
	}

	putWorkItem(threadId: string, workRowId: string, row: TranscriptRow) {
		const work = this.#thread(threadId).work;
		const items = (work[workRowId] ??= []);
		const index = items.findIndex((candidate) => candidate.id === row.id);

		if (index === -1) items.push(row);
		else items[index] = row;
		this.#emit(`work:${threadId}:${workRowId}`, { type: 'row', row });
	}

	putDetail(threadId: string, row: TranscriptRow) {
		this.#thread(threadId).items[row.id] = row;
		this.#emit(`item:${threadId}:${row.id}`, { type: 'row', row });
	}

	appendText(threadId: string, rowId: string, text: string) {
		const row = this.#thread(threadId).rows.find((candidate) => candidate.id === rowId);

		if (row?.kind !== 'text') throw new Error(`Row ${rowId} is not a text row.`);
		const offset = row.text.length;
		row.text += text;
		this.#emit(`thread:${threadId}`, { type: 'append', rowId, offset, text });
	}

	#thread(threadId: string) {
		let fixture = this.#threads.get(threadId);

		if (!fixture) {
			fixture = { rows: [], work: {}, items: {} };
			this.#threads.set(threadId, fixture);
		}

		return fixture;
	}

	#detail(threadId: string, rowId: string) {
		const fixture = this.#thread(threadId);

		return (
			fixture.items[rowId] ??
			Object.values(fixture.work)
				.flat()
				.find((row) => row.id === rowId) ??
			fixture.rows.find((row) => row.id === rowId)
		);
	}

	#emit(key: string, update: Extract<TranscriptEvent, { type: 'batch' }>['updates'][number]) {
		for (const listener of this.#listeners.get(key) ?? []) {
			listener({ type: 'batch', updates: [structuredClone(update)] });
		}
	}

	#watch(
		key: string,
		rows: () => TranscriptRow[],
		{ signal, onEvent }: WatchHandlers<TranscriptEvent>
	) {
		return new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();

			const listeners = this.#listeners.get(key) ?? new Set<Listener>();
			this.#listeners.set(key, listeners);
			listeners.add(onEvent);
			onEvent(snapshot(structuredClone(rows())));

			signal.addEventListener(
				'abort',
				() => {
					listeners.delete(onEvent);
					resolve();
				},
				{ once: true }
			);
		});
	}
}
