import { afterEach, expect, it, vi } from 'vitest';
import { fixtureId } from '$lib/convex-test-client';
import type {
	TranscriptEvent,
	TranscriptRow,
	TranscriptSnapshot,
	TranscriptScopeRequest,
	WatchHandlers
} from '$lib/types/sprocket';
import { TranscriptStore, type TranscriptStoreApi } from './transcript-store';

const threadId = fixtureId<'threadRecords'>('thread');
const scope = { userId: 'user', threadId };
const stops: Array<() => void> = [];

function snapshot(rows: TranscriptRow[], nextBefore: number | null = null): TranscriptSnapshot {
	return { type: 'snapshot', rows, nextBefore, stale: false };
}

function text(id: string, value = id): TranscriptRow {
	return { id, runId: 'run', kind: 'text', text: value, running: true };
}

function watcher() {
	const sessions: Array<WatchHandlers<TranscriptEvent> & { end: () => void; fail: () => void }> =
		[];

	const watch = vi.fn(
		(
			_request: TranscriptScopeRequest & { before?: number; rowId?: string },
			handlers: WatchHandlers<TranscriptEvent>
		) => {
			const pending = Promise.withResolvers<void>();
			sessions.push({
				...handlers,
				end: () => pending.resolve(),
				fail: () => pending.reject(new Error('Disconnected'))
			});
			handlers.signal.addEventListener('abort', () => pending.resolve(), { once: true });

			return pending.promise;
		}
	);

	return { watch, sessions };
}

function setup(rows: TranscriptRow[], before: number | null = null) {
	const thread = watcher();
	const work = watcher();
	const item = watcher();

	const api = {
		fetchTranscriptRows: vi.fn(async () => snapshot([])),
		fetchTranscriptRow: vi.fn<TranscriptStoreApi['fetchTranscriptRow']>(async () => ({
			row: text('reply')
		})),
		watchTranscript: thread.watch,
		watchTranscriptWork: work.watch,
		watchTranscriptItem: item.watch
	};

	const store = new TranscriptStore();
	store.selectThread(threadId);
	stops.push(store.watch({ api, ...scope, isCurrent: () => true }));
	thread.sessions[0].onEvent(snapshot(rows, before));

	return { store, api, thread, work, item };
}

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	vi.useRealTimers();
});

it('notifies only the appended row and uses UTF-16 offsets', () => {
	const { store, thread } = setup([text('a', 'a😀'), text('b')]);
	const list = vi.fn();
	const first = vi.fn();
	const second = vi.fn();
	store.subscribe(list);
	store.subscribeRow('a', first);
	store.subscribeRow('b', second);
	thread.sessions[0].onEvent({
		type: 'batch',
		updates: [{ type: 'append', rowId: 'a', offset: 3, text: '!' }]
	});
	expect(store.getRow('a')).toMatchObject({ text: 'a😀!' });
	expect(first).toHaveBeenCalledOnce();
	expect(second).not.toHaveBeenCalled();
	expect(list).not.toHaveBeenCalled();
});

it('keeps paging through status snapshots and watches all loaded history', async () => {
	const recent = text('recent');

	const older: TranscriptRow = {
		id: 'old-work',
		runId: 'run',
		kind: 'work',
		running: true,
		toolCounts: {}
	};

	const { store, api, thread } = setup([recent], 200);
	const pending = Promise.withResolvers<TranscriptSnapshot>();
	api.fetchTranscriptRows.mockReturnValueOnce(pending.promise);
	const loading = store.loadOlder();
	thread.sessions[0].onEvent({ ...snapshot([recent], 200), stale: true });
	expect(store.loadingOlder).toBe(true);
	pending.resolve(snapshot([older, recent], 100));
	await loading;
	expect(store.stale).toBe(true);
	expect(api.fetchTranscriptRows).toHaveBeenCalledWith(
		{ ...scope, before: 200 },
		expect.any(AbortSignal)
	);
	expect(thread.sessions[0].signal.aborted).toBe(true);
	expect(api.watchTranscript).toHaveBeenLastCalledWith(
		{ ...scope, before: 100 },
		expect.anything()
	);
	thread.sessions[1].onEvent(snapshot([older, recent], 100));
	expect(store.rowIds).toEqual(['old-work', 'recent']);
	thread.sessions[1].onEvent({
		type: 'batch',
		updates: [{ type: 'row', row: { ...older, toolCounts: { exec_cmd: 2 }, running: false } }]
	});
	expect(store.getRow('old-work')).toMatchObject({ toolCounts: { exec_cmd: 2 }, running: false });
	api.fetchTranscriptRows.mockResolvedValueOnce(snapshot([text('oldest'), older], null));
	await store.loadOlder();
	expect(api.watchTranscript).toHaveBeenLastCalledWith({ ...scope, before: 0 }, expect.anything());
	expect(store.rowIds).toEqual(['oldest', 'old-work', 'recent']);
});

it.each([50, 100])(
	'applies structural snapshots with cursor %j while paging',
	async (nextBefore) => {
		const { store, api, thread } = setup([text('a'), text('b')], 100);
		const pending = Promise.withResolvers<TranscriptSnapshot>();
		api.fetchTranscriptRows.mockReturnValueOnce(pending.promise);
		const loading = store.loadOlder();
		thread.sessions[0].onEvent(snapshot([text('b'), text('c')], nextBefore));
		pending.resolve(snapshot([text('older'), text('a')], null));
		await loading;
		expect(store.rowIds).toEqual(['b', 'c']);
		expect(store.getRow('a')).toBeUndefined();
		expect(store.nextBefore).toBe(nextBefore);
		expect(store.loadingOlder).toBe(false);
	}
);

it.each(['abcXY', 'abcXYZ', 'abcXYZ!'])(
	'refetches only the mismatched row and joins queued appends onto %j',
	async (fetchedText) => {
		const { store, api, thread } = setup([text('reply', 'a'), text('untouched')]);
		const pending = Promise.withResolvers<{ row: TranscriptRow }>();
		api.fetchTranscriptRow.mockReturnValueOnce(pending.promise);
		thread.sessions[0].onEvent({
			type: 'batch',
			updates: [{ type: 'append', rowId: 'reply', offset: 3, text: 'XYZ' }]
		});
		thread.sessions[0].onEvent({
			type: 'batch',
			updates: [{ type: 'append', rowId: 'reply', offset: 6, text: '!' }]
		});
		pending.resolve({ row: text('reply', fetchedText) });
		await pending.promise;
		await Promise.resolve();
		expect(api.fetchTranscriptRow).toHaveBeenCalledExactlyOnceWith(
			{ ...scope, rowId: 'reply' },
			expect.any(AbortSignal)
		);
		expect(api.watchTranscript).toHaveBeenCalledTimes(1);
		expect(store.getRow('reply')).toMatchObject({ text: 'abcXYZ!' });
		expect(store.getRow('untouched')).toMatchObject({ text: 'untouched' });
	}
);

it('refetches a missing row and full reasoning text for an open item', async () => {
	const block: TranscriptRow = {
		id: 'work',
		runId: 'run',
		kind: 'work',
		running: true,
		toolCounts: {}
	};

	const reasoning: TranscriptRow = {
		id: 'reason',
		runId: 'run',
		kind: 'reasoning',
		label: 'Reasoning',
		running: true
	};

	const { store, api, thread, work, item } = setup([block]);
	api.fetchTranscriptRow.mockResolvedValueOnce({ row: text('missing', 'Recovered!') });
	thread.sessions[0].onEvent({
		type: 'batch',
		updates: [{ type: 'append', rowId: 'missing', offset: 9, text: '!' }]
	});
	await Promise.resolve();
	expect(store.rowIds).toEqual(['work', 'missing']);
	store.openWork('work');
	work.sessions[0].onEvent(snapshot([reasoning]));
	store.openItem('reason');
	item.sessions[0].onEvent(snapshot([{ ...reasoning, text: 'a' }]));
	api.fetchTranscriptRow.mockResolvedValueOnce({ row: { ...reasoning, text: 'abc!' } });
	item.sessions[0].onEvent({
		type: 'batch',
		updates: [{ type: 'append', rowId: 'reason', offset: 3, text: '!' }]
	});
	await Promise.resolve();
	expect(store.getRow('reason', true)).toMatchObject({ text: 'abc!' });
	expect(store.getRow('reason')).toEqual(reasoning);
	expect(api.fetchTranscriptRow).toHaveBeenLastCalledWith(
		{ ...scope, rowId: 'reason' },
		expect.any(AbortSignal)
	);
});

it('starts at newest after disconnect and reopens wanted work and item subscriptions', async () => {
	vi.useFakeTimers();

	const block: TranscriptRow = {
		id: 'work',
		runId: 'run',
		kind: 'work',
		running: true,
		toolCounts: {}
	};

	const reasoning: TranscriptRow = {
		id: 'reason',
		runId: 'run',
		kind: 'reasoning',
		label: 'Reasoning',
		running: true
	};

	const { store, api, thread, work, item } = setup([block], 200);
	api.fetchTranscriptRows.mockResolvedValueOnce(snapshot([text('older'), block], 100));
	await store.loadOlder();
	thread.sessions[1].onEvent(snapshot([text('older'), block], 100));
	store.openWork('work');
	work.sessions[0].onEvent(snapshot([reasoning]));
	store.openItem('reason');
	item.sessions[0].onEvent(snapshot([{ ...reasoning, text: 'old text' }]));
	thread.sessions[1].fail();
	await Promise.resolve();
	expect(store.rowIds).toEqual([]);
	expect(store.stale).toBe(true);
	expect(store.getRow('reason', true)).toBeUndefined();
	expect(work.sessions[0].signal.aborted).toBe(true);
	expect(item.sessions[0].signal.aborted).toBe(true);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(api.watchTranscript).toHaveBeenLastCalledWith(scope, expect.anything());
	thread.sessions[2].onEvent(snapshot([block]));
	work.sessions[1].onEvent(snapshot([reasoning]));
	expect(item.sessions).toHaveLength(2);
	expect(store.rowIds).toEqual(['work']);
	work.sessions[1].end();
	await vi.advanceTimersByTimeAsync(1_000);
	expect(work.sessions).toHaveLength(3);
	item.sessions[1].fail();
	await vi.advanceTimersByTimeAsync(1_000);
	expect(item.sessions).toHaveLength(3);
});
