import { describe, expect, it, vi } from 'vitest';
import { DisplayHistory, visibleDisplayMessages } from './display-history';
import type {
	LiveCompletionOverlay,
	TranscriptDisplayPage,
	TranscriptDisplayRow
} from '$lib/types/sprocket';

function row(sequence: number, revision = sequence): TranscriptDisplayRow {
	return {
		// SAFETY: fixture IDs stay within the in-memory pager.
		id: `row-${sequence}` as TranscriptDisplayRow['id'],
		// SAFETY: fixture IDs stay within the in-memory pager.
		threadId: 'thread' as TranscriptDisplayRow['threadId'],
		// SAFETY: fixture IDs stay within the in-memory pager.
		runId: 'run' as TranscriptDisplayRow['runId'],
		sequence,
		kind: 'work',
		itemCount: 4_000,
		pendingTools: 0,
		startedAt: 0,
		completedAt: 4_000_000,
		closed: true,
		revision
	};
}

function page(rows: TranscriptDisplayRow[], nextBefore?: number): TranscriptDisplayPage {
	return {
		replicaId: 'replica',
		rows,
		nextBefore,
		indexing: false,
		stale: false,
		endSequence: 100,
		revision: 100,
		persistedStreams: [],
		changes: [],
		changesCursor: { revision: 100, sequence: -1 },
		moreChanges: false
	};
}

describe('DisplayHistory', () => {
	it('checks overlays that arrive during an in-flight history request', async () => {
		const live: LiveCompletionOverlay = {
			threadId: row(0).threadId,
			runId: row(0).runId,
			streamId: 'late',
			runStatus: 'running',
			runStartedAt: 1,
			text: 'Answer',
			parts: []
		};
		let resolve!: (value: TranscriptDisplayPage) => void;
		const fetch = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<TranscriptDisplayPage>((done) => {
						resolve = done;
					})
			)
			.mockResolvedValueOnce({
				...page([row(0)]),
				persistedStreams: [{ runId: live.runId, streamId: 'late' }]
			});
		const history = new DisplayHistory(fetch, () => {});
		const initial = history.refresh();
		history.setOverlays([live]);
		resolve(page([row(0)]));
		expect(history.visibleOverlays([live])).toEqual([]);
		await initial;
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(history.unpersisted([live])).toEqual([]);
		history.stop();
	});

	it('drains more than one bounded batch of persisted overlays', async () => {
		const overlays: LiveCompletionOverlay[] = Array.from({ length: 65 }, (_, index) => ({
			threadId: row(0).threadId,
			runId: row(0).runId,
			streamId: `stream-${index}`,
			runStatus: 'running',
			runStartedAt: 1,
			text: 'Answer',
			parts: []
		}));
		const fetch = vi.fn(
			async (request: { streams?: TranscriptDisplayPage['persistedStreams'] }) => ({
				...page([row(0)]),
				persistedStreams: request.streams ?? []
			})
		);
		const history = new DisplayHistory(fetch, () => {});
		history.setOverlays(overlays);
		await vi.waitFor(() => expect(history.unpersisted(overlays)).toEqual([]));
		expect(fetch.mock.calls.map(([request]) => request.streams?.length)).toEqual([64, 1]);
		history.stop();
	});

	it('refreshes the current window before accepting a handoff from older pagination', async () => {
		const live: LiveCompletionOverlay = {
			threadId: row(0).threadId,
			runId: row(0).runId,
			streamId: 'live',
			runStatus: 'running',
			runStartedAt: 1,
			text: 'Answer',
			parts: []
		};
		const persistedStreams = [{ runId: live.runId, streamId: 'live' }];
		let resolve!: (value: TranscriptDisplayPage) => void;
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(40)], 40))
			.mockResolvedValueOnce({ ...page([row(1)]), persistedStreams })
			.mockImplementationOnce(
				() =>
					new Promise<TranscriptDisplayPage>((done) => {
						resolve = done;
					})
			)
			.mockResolvedValueOnce(page([row(1)]));
		const history = new DisplayHistory(fetch, () => {});
		history.setOverlays([live]);
		await vi.waitFor(() => expect(history.visibleOverlays([live])).toEqual([live]));
		await history.loadOlder();
		expect(history.visibleOverlays([live])).toEqual([live]);
		expect(history.messages.map((row) => row.sequence)).toEqual([40]);
		resolve({ ...page([row(40)], 40), persistedStreams });
		await vi.waitFor(() => expect(history.messages.map((row) => row.sequence)).toEqual([1, 40]));
		expect(history.visibleOverlays([live])).toEqual([]);
		history.stop();
	});

	it('restores older navigation when delayed memberships arrive', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([16, 17, 18, 19].map((sequence) => row(sequence))))
			.mockResolvedValueOnce({
				...page(
					Array.from({ length: 12 }, (_, index) => row(index + 8)),
					8
				),
				revision: 101
			});
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		await history.refresh();
		expect(history.nextBefore).toBe(8);
		history.stop();
	});

	it('keeps the previous window and overlay until a partial completion can hand off atomically', async () => {
		const live: LiveCompletionOverlay = {
			threadId: row(0).threadId,
			runId: row(0).runId,
			streamId: 'live',
			runStatus: 'running',
			runStartedAt: 1,
			text: 'Answer',
			parts: [{ type: 'text', id: 'answer', text: 'Answer' }]
		};
		const answer = { ...row(20), kind: 'text' as const, text: 'Answer' };
		const fetch = vi.fn().mockResolvedValue(page([row(0)]));
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		history.setOverlays([live]);
		expect(history.visibleOverlays([live])).toEqual([]);
		await vi.waitFor(() => expect(history.visibleOverlays([live])).toEqual([live]));
		fetch.mockResolvedValueOnce({ ...page([row(0), answer]), indexing: true, revision: 101 });
		await history.refresh();
		expect(history.messages.map((row) => row.id)).toEqual(['row-0']);
		expect(history.visibleOverlays([live])).toEqual([live]);
		fetch.mockResolvedValueOnce({
			...page([row(0), answer]),
			revision: 102,
			persistedStreams: [{ runId: live.runId, streamId: 'live' }]
		});
		await history.refresh();
		expect(history.messages.map((row) => row.text).filter(Boolean)).toEqual(['Answer']);
		expect(history.visibleOverlays([live])).toEqual([]);
		history.stop();
	});

	it('checks a late live subscription before showing an already persisted stream', async () => {
		const live: LiveCompletionOverlay = {
			threadId: row(0).threadId,
			runId: row(0).runId,
			streamId: 'late',
			runStatus: 'running',
			runStartedAt: 1,
			text: 'Answer',
			parts: []
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(0)]))
			.mockResolvedValueOnce({
				...page([row(0)]),
				persistedStreams: [{ runId: live.runId, streamId: 'late' }]
			});
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		history.setOverlays([live]);
		expect(history.visibleOverlays([live])).toEqual([]);
		await vi.waitFor(() => expect(history.unpersisted([live])).toEqual([]));
		expect(fetch.mock.calls[1][0].streams).toEqual([{ runId: live.runId, streamId: 'late' }]);
		history.stop();
	});
	it('accepts a rebuilt local replica whose counter starts below the previous copy', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(50)], 50))
			.mockResolvedValueOnce({ ...page([row(1, 1)]), replicaId: 'rebuilt', revision: 1 });
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		await history.refresh();
		expect(history.messages.map((message) => message.sequence)).toEqual([1]);
		expect(history.windowVersion).toBe(1);
		history.stop();
	});

	it('inserts background-downloaded text into an already loaded older window', async () => {
		const added = { ...row(25, 101), kind: 'text' as const, text: 'Downloaded later' };
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(10), row(50)], 10))
			.mockResolvedValueOnce({
				...page([row(50)], 50),
				revision: 101,
				changes: [{ id: added.id, row: added }]
			});
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		await history.refresh();
		expect(history.messages.map((message) => message.sequence)).toEqual([10, 25, 50]);
		history.stop();
	});

	it('retains a live completion until the display index acknowledges its stream', async () => {
		const live: LiveCompletionOverlay = {
			threadId: row(0).threadId,
			runId: row(0).runId,
			streamId: 'live',
			runStatus: 'running',
			runStartedAt: 1,
			text: 'Answer',
			parts: [{ type: 'text', id: 'answer', text: 'Answer' }]
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([{ ...row(0), provisional: true }]))
			.mockResolvedValueOnce({
				...page([row(1)]),
				persistedStreams: [{ runId: live.runId, streamId: live.streamId }]
			});
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		expect(history.unpersisted([live])).toEqual([live]);
		expect(visibleDisplayMessages(history.messages, [live])).toEqual([]);
		expect(visibleDisplayMessages(history.messages, [])).toHaveLength(1);
		await history.refresh();
		expect(history.unpersisted([live])).toEqual([]);
		history.stop();
	});

	it('retries a failed initial load and clears the error after recovery', async () => {
		vi.useFakeTimers();
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValue(page([row(1)]));
		const history = new DisplayHistory(fetch, () => {});
		try {
			await history.refresh();
			expect(history.error).toBe('Could not load conversation history.');
			expect(history.stale).toBe(true);
			expect(history.loading).toBe(false);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(history.error).toBeNull();
			expect(history.stale).toBe(false);
			expect(history.messages.map((message) => message.id)).toEqual(['row-1']);
		} finally {
			history.stop();
			vi.useRealTimers();
		}
	});

	it('updates and deletes loaded sections outside the recent window', async () => {
		const updated = row(1, 200);
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(40)], 40))
			.mockResolvedValueOnce(page([row(1), row(2)]))
			.mockResolvedValueOnce({
				...page([row(40)], 40),
				revision: 201,
				changes: [
					{ id: updated.id, row: updated },
					{ id: row(2).id, row: null }
				]
			});
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		await history.loadOlder();
		await history.refresh();
		expect(history.messages.map((message) => message.id)).toEqual(['row-1', 'row-40']);
		expect(history.messages[0].revision).toBe(200);
		history.stop();
	});

	it('rejects an older page that would reintroduce state from before a concurrent refresh', async () => {
		let resolveOlder!: (page: TranscriptDisplayPage) => void;
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(40)], 40))
			.mockImplementationOnce(
				() =>
					new Promise<TranscriptDisplayPage>((resolve) => {
						resolveOlder = resolve;
					})
			)
			.mockResolvedValueOnce({ ...page([row(40, 101)], 40), revision: 102 });
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		const older = history.loadOlder();
		await history.refresh();
		resolveOlder(page([row(1)]));
		await older;
		expect(history.messages.map((message) => message.id)).toEqual(['row-40']);
		expect(history.nextBefore).toBe(40);
		expect(history.stale).toBe(true);
		history.stop();
	});

	it('follows bounded change pages and does not let an overlapping row undo a newer change', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(1)]))
			.mockResolvedValueOnce({
				...page([row(1)]),
				revision: 102,
				moreChanges: true,
				changesCursor: { revision: 101, sequence: 64 },
				changes: [{ id: row(1).id, row: row(1, 101) }]
			})
			.mockResolvedValueOnce({ ...page([row(1, 101)]), revision: 102 });
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		await history.refresh();
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(fetch.mock.calls[2][0].changesAfter).toEqual({ revision: 101, sequence: 64 });
		expect(history.messages[0].revision).toBe(101);
		history.stop();
	});
	it('retains only a summary for a long section and preserves unchanged row identities', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(40)], 40))
			.mockResolvedValueOnce(page([row(0)]))
			.mockResolvedValueOnce(page([row(40)], 40));
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		const summary = history.messages[0];
		await history.loadOlder();
		await history.refresh();
		expect(history.messages[1]).toBe(summary);
		expect(history.messages[1]).not.toHaveProperty('parts');
		expect(fetch.mock.calls).toEqual([
			[{ limit: 12 }],
			[{ before: 40, limit: 40 }],
			[{ limit: 12, changesAfter: { revision: 100, sequence: -1 } }]
		]);
		history.stop();
	});

	it('removes rows no longer present in the refreshed range', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(1), row(2)]))
			.mockResolvedValueOnce(page([row(2), row(3)]));
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		await history.refresh();
		expect(history.messages.map((message) => message.id)).toEqual(['row-2', 'row-3']);
		history.stop();
	});

	it('discards an older request after a refresh replaces a history gap', async () => {
		let resolveOlder!: (page: TranscriptDisplayPage) => void;
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(page([row(5)], 5))
			.mockImplementationOnce(
				() =>
					new Promise<TranscriptDisplayPage>((resolve) => {
						resolveOlder = resolve;
					})
			)
			.mockResolvedValueOnce(page([row(90)], 90));
		const history = new DisplayHistory(fetch, () => {});
		await history.refresh();
		const older = history.loadOlder();
		await history.refresh();
		resolveOlder(page([row(1)]));
		await older;
		expect(history.messages.map((message) => message.id)).toEqual(['row-90']);
		expect(history.windowVersion).toBe(1);
		history.stop();
	});
});
