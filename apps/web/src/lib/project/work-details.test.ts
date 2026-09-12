import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptDetailCursor, TranscriptDisplayDetails } from '$lib/types/sprocket';
import { WorkDetails } from './work-details';

function page(
	ids: number[],
	previousBefore?: number,
	nextAfter?: number
): TranscriptDisplayDetails {
	return {
		parts: ids.map((id) => ({ type: 'reasoning', id: String(id), text: `Reason ${id}` })),
		previousBefore,
		nextAfter,
		indexing: false,
		stale: false,
		revision: 1
	};
}

function history(
	load: (cursor: TranscriptDetailCursor, signal: AbortSignal) => Promise<TranscriptDisplayDetails>,
	latest = false
) {
	return new WorkDetails(
		latest,
		load,
		() => {},
		async (update) => {
			update();
		}
	);
}

afterEach(() => {
	vi.useRealTimers();
});

describe('WorkDetails', () => {
	it('keeps both ends of an active section and refreshes from a fixed start, not a sliding latest page', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([6, 7], 6))
			.mockResolvedValueOnce(page([4, 5], 4, 5))
			.mockResolvedValueOnce(page([4, 5], 4, 5))
			.mockResolvedValueOnce(page([6, 7], 6, 7))
			.mockResolvedValueOnce(page([8, 9], 8));
		const details = history(load, true);
		await details.refresh();
		await details.more('older');
		expect(details.parts).toEqual(page([4, 5, 6, 7]).parts);
		await details.refresh();
		expect(details.parts).toEqual(page([4, 5, 6, 7]).parts);
		await details.more('newer');
		expect(details.parts).toEqual(page([4, 5, 6, 7, 8, 9]).parts);
		expect(load.mock.calls.map(([cursor]) => cursor)).toEqual([
			{ latest: true },
			{ before: 6 },
			{ after: 3 },
			{ after: 5 },
			{ after: 7 }
		]);
		details.stop();
	});

	it('refreshes all retained details together, including insertions and removed items', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([1, 3], undefined, 3))
			.mockResolvedValueOnce(page([4, 5], 4, 5))
			.mockResolvedValueOnce(page([1, 2], undefined, 2))
			.mockResolvedValueOnce(page([3, 4], 3, 4))
			.mockResolvedValueOnce(page([6], 6));
		const details = history(load);
		await details.refresh();
		await details.more('newer');
		await details.refresh();
		expect(details.parts).toEqual(page([1, 2, 3, 4, 6]).parts);
		details.stop();
	});

	it('retries the failed edge without clearing already loaded details', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([1], undefined, 1))
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(page([2], 2));
		const details = history(load);
		await details.refresh();
		await details.more('newer');
		expect(details.error).toBe(true);
		expect(details.parts).toEqual(page([1]).parts);
		await details.retryFailed();
		expect(details.error).toBe(false);
		expect(details.parts).toEqual(page([1, 2]).parts);
		expect(load.mock.calls[2][0]).toEqual({ after: 1 });
		details.stop();
	});

	it('coalesces revision changes behind a pending page instead of cancelling it', async () => {
		let resolve!: (page: TranscriptDisplayDetails) => void;
		const load = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<TranscriptDisplayDetails>((done) => {
						resolve = done;
					})
			)
			.mockResolvedValueOnce(page([1, 2]));
		const details = history(load);
		const pending = details.refresh();
		void details.refresh();
		void details.refresh();
		resolve(page([1]));
		await pending;
		await vi.waitFor(() => expect(details.parts).toEqual(page([1, 2]).parts));
		expect(load).toHaveBeenCalledTimes(2);
		details.stop();
	});

	it('cancels indexing retries and ignores late results after collapse', async () => {
		vi.useFakeTimers();
		const load = vi.fn().mockResolvedValue({ ...page([]), indexing: true });
		const details = history(load);
		await details.refresh();
		details.stop();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(load).toHaveBeenCalledTimes(1);
		expect(load.mock.calls[0][1].aborted).toBe(true);

		let resolve!: (page: TranscriptDisplayDetails) => void;
		const pending = history(
			() =>
				new Promise((done) => {
					resolve = done;
				})
		);
		const request = pending.refresh();
		pending.stop();
		resolve(page([1]));
		await request;
		expect(pending.parts).toEqual([]);
	});

	it('stops a non-advancing cursor without a request loop', async () => {
		const load = vi.fn().mockResolvedValue(page([1], undefined, 1));
		const details = history(load);
		await details.refresh();
		await details.more('newer');
		expect(details.error).toBe(true);
		expect(load).toHaveBeenCalledTimes(2);
		details.stop();
	});

	it('retains loaded work if a later page comes from an older replica revision', async () => {
		vi.useFakeTimers();
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([1], undefined, 1))
			.mockResolvedValueOnce(page([2], 2))
			.mockResolvedValueOnce({ ...page([1], undefined, 1), revision: 2 })
			.mockResolvedValueOnce(page([3], 3))
			.mockResolvedValue({ ...page([1, 3]), revision: 2 });
		const details = history(load);
		await details.refresh();
		await details.more('newer');
		await details.refresh();
		expect(details.parts).toEqual(page([1, 2]).parts);
		await vi.advanceTimersByTimeAsync(500);
		expect(details.parts).toEqual(page([1, 3]).parts);
		details.stop();
	});

	it('refreshes a retained range while the active run keeps advancing its revision', async () => {
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([1], undefined, 1))
			.mockResolvedValueOnce(page([2], 2))
			.mockResolvedValueOnce({ ...page([1], undefined, 1), revision: 2 })
			.mockResolvedValueOnce({ ...page([2, 3], 2), revision: 3 });
		const details = history(load);
		await details.refresh();
		await details.more('newer');
		await details.refresh();
		expect(details.parts).toEqual(page([1, 2, 3]).parts);
		expect(details.indexing).toBe(false);
		details.stop();
	});

	it('does not discard work on an empty stale response or lock an empty latest page to the start', async () => {
		vi.useFakeTimers();
		const load = vi
			.fn()
			.mockResolvedValueOnce({ ...page([]), stale: true })
			.mockResolvedValueOnce(page([9], 9))
			.mockResolvedValueOnce({ ...page([]), stale: true })
			.mockResolvedValueOnce(page([9], 9));
		const details = history(load, true);
		await details.refresh();
		await vi.advanceTimersByTimeAsync(500);
		expect(load.mock.calls[1][0]).toEqual({ latest: true });
		await details.refresh();
		expect(details.parts).toEqual(page([9]).parts);
		await vi.advanceTimersByTimeAsync(500);
		expect(details.stale).toBe(false);
		details.stop();
	});

	it('bounds a refresh when its old tail disappears, retaining the screen on failure', async () => {
		let id = 1;
		const load = vi
			.fn()
			.mockResolvedValueOnce(page([1]))
			.mockImplementation(async () => {
				id += 1;
				return page([id], id, id);
			});
		const details = history(load);
		await details.refresh();
		await details.refresh();
		expect(details.error).toBe(true);
		expect(details.parts).toEqual(page([1]).parts);
		expect(load).toHaveBeenCalledTimes(3);
		details.stop();
	});
});
