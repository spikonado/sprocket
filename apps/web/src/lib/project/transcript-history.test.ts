import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import type { LocalTranscriptPage, ThreadMessage } from '$lib/types/sprocket';
import { TranscriptHistory } from './transcript-history';

// SAFETY: These tests only compare opaque fixture IDs.
const threadId = 'thread' as Id<'threadRecords'>;

function message(number: number): ThreadMessage {
	return {
		_id: `prompt:${number}`,
		threadId,
		// SAFETY: These tests only compare opaque fixture IDs.
		runId: `run-${number}` as Id<'runs'>,
		userId: 'user',
		type: 'prompt',
		text: String(number),
		parts: [],
		attachments: [],
		runStatus: 'completed',
		runStartedAt: 1,
		sourceNumbers: [number]
	};
}

function page(numbers: number[], nextBefore?: number): LocalTranscriptPage {
	return {
		threadId,
		totalParts: 100,
		historyFromNumber: 0,
		stale: false,
		messages: numbers.map(message),
		nextBefore
	};
}

function texts(history: TranscriptHistory) {
	return history.messages.map((entry) => entry.text);
}

afterEach(() => vi.useRealTimers());

describe('TranscriptHistory', () => {
	it('keeps watch-triggered refreshes within the recent page instead of expanding older history', async () => {
		const fetchPage = vi.fn(async ({ before = 100, limit }: { before?: number; limit: number }) => {
			const start = Math.max(0, before - limit);
			return page(
				Array.from({ length: before - start }, (_, index) => start + index),
				start
			);
		});
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		await history.refresh();
		expect(history.messages).toHaveLength(12);
		expect(history.messages[0]?.sourceNumbers).toEqual([88]);
		expect(history.nextBefore).toBe(88);
		expect(fetchPage.mock.calls.map(([request]) => request.limit)).toEqual([12, 12]);
		history.stop();
	});

	it('loads a bounded first page without automatically paging older history', async () => {
		vi.useFakeTimers();
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([4, 5], 4))
			.mockResolvedValueOnce(page([2, 3], 2))
			.mockResolvedValueOnce(page([0, 1]));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		expect(texts(history)).toEqual(['4', '5']);
		expect(history.nextBefore).toBe(4);
		await vi.runAllTimersAsync();
		expect(texts(history)).toEqual(['4', '5']);
		expect(fetchPage.mock.calls.map(([request]) => request)).toEqual([{ limit: 12 }]);
		history.stop();
	});

	it('loads the next older page only when asked', async () => {
		vi.useFakeTimers();
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([4, 5], 4))
			.mockResolvedValueOnce(page([2, 3], 2))
			.mockResolvedValueOnce(page([0, 1]));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		await history.loadOlder();
		expect(texts(history)).toEqual(['2', '3', '4', '5']);
		expect(history.nextBefore).toBe(2);
		await vi.runAllTimersAsync();
		expect(texts(history)).toEqual(['2', '3', '4', '5']);
		expect(fetchPage.mock.calls.map(([request]) => request)).toEqual([
			{ limit: 12 },
			{ before: 4, limit: 40 }
		]);
		history.stop();
	});

	it('does not retry a failed older page on a timer', async () => {
		vi.useFakeTimers();
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([4, 5], 4))
			.mockRejectedValueOnce(new Error('offline'));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		await history.loadOlder();
		expect(texts(history)).toEqual(['4', '5']);
		expect(history.nextBefore).toBe(4);
		expect(history.stale).toBe(true);
		await vi.runAllTimersAsync();
		expect(fetchPage).toHaveBeenCalledTimes(2);
		history.stop();
	});

	it('keeps an older-page request that arrives during refresh', async () => {
		vi.useFakeTimers();
		let resolveFirst: (value: LocalTranscriptPage) => void = () => {};
		const fetchPage = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<LocalTranscriptPage>((done) => {
						resolveFirst = done;
					})
			)
			.mockResolvedValueOnce(page([2, 3], 2))
			.mockResolvedValueOnce(page([0, 1]));
		const history = new TranscriptHistory(fetchPage, () => {});
		const first = history.refresh();
		await history.loadOlder();
		await history.loadOlder();
		expect(fetchPage).toHaveBeenCalledTimes(1);
		resolveFirst(page([4, 5], 4));
		await first;
		await Promise.resolve();
		expect(texts(history)).toEqual(['2', '3', '4', '5']);
		expect(history.nextBefore).toBe(2);
		await vi.runAllTimersAsync();
		expect(fetchPage.mock.calls.map(([request]) => request)).toEqual([
			{ limit: 12 },
			{ before: 4, limit: 40 }
		]);
		history.stop();
	});

	it('ignores a queued older page after stop', async () => {
		let resolveFirst: (value: LocalTranscriptPage) => void = () => {};
		const fetchPage = vi.fn(
			() =>
				new Promise<LocalTranscriptPage>((done) => {
					resolveFirst = done;
				})
		);
		const changed = vi.fn();
		const history = new TranscriptHistory(fetchPage, changed);
		const first = history.refresh();
		await history.loadOlder();
		history.stop();
		resolveFirst(page([4, 5], 4));
		await first;
		await Promise.resolve();
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(changed).not.toHaveBeenCalled();
		expect(texts(history)).toEqual([]);
	});

	it('fills every gap after reconnecting beyond the newest page', async () => {
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([0, 1]))
			.mockResolvedValueOnce(page([6, 7], 6))
			.mockResolvedValueOnce(page([4, 5], 4))
			.mockResolvedValueOnce(page([1, 2, 3], 1));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		await history.refresh();
		expect(texts(history)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
		expect(history.nextBefore).toBeUndefined();
		history.stop();
	});

	it('coalesces concurrent refreshes and ignores requests completed after a thread switch', async () => {
		let resolve: (value: LocalTranscriptPage) => void = () => {};
		const fetchPage = vi.fn(
			() =>
				new Promise<LocalTranscriptPage>((done) => {
					resolve = done;
				})
		);
		const changed = vi.fn();
		const history = new TranscriptHistory(fetchPage, changed);
		const first = history.refresh();
		await history.refresh();
		expect(fetchPage).toHaveBeenCalledTimes(1);
		history.stop();
		resolve(page([1]));
		await first;
		expect(changed).not.toHaveBeenCalled();
	});

	it('retries a failed catch-up without committing a gap in history', async () => {
		vi.useFakeTimers();
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([0, 1]))
			.mockResolvedValueOnce(page([4, 5], 4))
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(page([4, 5], 4))
			.mockResolvedValueOnce(page([1, 2, 3], 1));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		await history.refresh();
		expect(texts(history)).toEqual(['0', '1']);
		expect(history.stale).toBe(true);
		await vi.runAllTimersAsync();
		expect(texts(history)).toEqual(['0', '1', '2', '3', '4', '5']);
		history.stop();
	});
});
