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

afterEach(() => vi.useRealTimers());

describe('TranscriptHistory', () => {
	it('loads all older pages without waiting for a scroll event', async () => {
		vi.useFakeTimers();
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([4, 5], 4))
			.mockResolvedValueOnce(page([2, 3], 2))
			.mockResolvedValueOnce(page([0, 1]));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		expect(history.messages.map((entry) => entry.text)).toEqual(['4', '5']);
		await vi.runAllTimersAsync();
		expect(history.messages.map((entry) => entry.text)).toEqual(['0', '1', '2', '3', '4', '5']);
		expect(fetchPage.mock.calls.map(([request]) => request.limit)).toEqual([12, 40, 40]);
		history.stop();
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
		expect(history.messages.map((entry) => entry.text)).toEqual([
			'0',
			'1',
			'2',
			'3',
			'4',
			'5',
			'6',
			'7'
		]);
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
		expect(history.messages.map((entry) => entry.text)).toEqual(['0', '1']);
		expect(history.stale).toBe(true);
		await vi.runAllTimersAsync();
		expect(history.messages.map((entry) => entry.text)).toEqual(['0', '1', '2', '3', '4', '5']);
		history.stop();
	});
});
