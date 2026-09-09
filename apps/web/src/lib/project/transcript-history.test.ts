import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '$convex/_generated/dataModel';
import type { AssistantPart } from '$convex/lib/assistantParts';
import type { LocalTranscriptPage, LocalTranscriptPart, ThreadMessage } from '$lib/types/sprocket';
import { TranscriptHistory } from './transcript-history';

// SAFETY: These tests only compare opaque fixture IDs.
const threadId = 'thread' as Id<'threadRecords'>;

function promptPart(number: number): LocalTranscriptPart {
	return {
		number,
		kind: 'prompt',
		message: {
			_id: `prompt:run-${number}`,
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
			sourceNumbers: [number],
			streamIds: [],
			detailsLoaded: true
		}
	};
}

function page(numbers: number[], nextBefore?: number): LocalTranscriptPage {
	return {
		threadId,
		totalParts: 100,
		historyFromNumber: 0,
		stale: false,
		parts: numbers.map(promptPart),
		nextBefore
	};
}

function partsPage(parts: LocalTranscriptPart[], nextBefore?: number): LocalTranscriptPage {
	return {
		threadId,
		totalParts: 100,
		historyFromNumber: 0,
		stale: false,
		parts,
		nextBefore
	};
}

function completionPart(
	number: number,
	runId: string,
	overrides: Partial<ThreadMessage> = {}
): LocalTranscriptPart {
	const text = overrides.text ?? `t${number}`;
	return {
		number,
		kind: 'completion',
		message: {
			_id: `response:${runId}`,
			threadId,
			// SAFETY: These tests only compare opaque fixture IDs.
			runId: runId as Id<'runs'>,
			userId: 'user',
			type: 'response',
			text,
			parts: overrides.parts ?? [{ type: 'text', id: `t-${number}`, text }],
			attachments: [],
			runStatus: 'completed',
			runStartedAt: 0,
			sourceNumbers: [number],
			streamIds: overrides.streamIds ?? [`stream-${number}`],
			detailsLoaded: false,
			...overrides
		}
	};
}

function toolPart(number: number, runId: string, parts: AssistantPart[]): LocalTranscriptPart {
	return {
		number,
		kind: 'tool',
		message: {
			_id: `response:${runId}`,
			threadId,
			// SAFETY: These tests only compare opaque fixture IDs.
			runId: runId as Id<'runs'>,
			userId: 'user',
			type: 'response',
			text: '',
			parts,
			attachments: [],
			runStatus: 'completed',
			runStartedAt: 0,
			sourceNumbers: [number],
			streamIds: [],
			detailsLoaded: false
		}
	};
}

function windowedFetch(parts: LocalTranscriptPart[], total = parts.length) {
	return async ({ before = total, limit }: { before?: number; limit: number }) => {
		const start = Math.max(0, before - limit);
		const slice = parts.filter((part) => part.number >= start && part.number < before);
		return partsPage(slice, start > 0 ? start : undefined);
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

	it('shows the newest window without downloading an offline gap', async () => {
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([0, 1]))
			.mockResolvedValueOnce(page([998, 999], 998))
			.mockResolvedValueOnce(page([996, 997], 996));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		await history.refresh();
		expect(texts(history)).toEqual(['998', '999']);
		expect(history.nextBefore).toBe(998);
		expect(history.windowVersion).toBe(1);
		expect(fetchPage).toHaveBeenCalledTimes(2);
		await history.loadOlder();
		expect(texts(history)).toEqual(['996', '997', '998', '999']);
		history.stop();
	});

	it('retains loaded history when the recent window is adjacent', async () => {
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([0, 1]))
			.mockResolvedValueOnce(page([2, 3], 2));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		await history.refresh();
		expect(texts(history)).toEqual(['0', '1', '2', '3']);
		expect(history.nextBefore).toBeUndefined();
		expect(history.windowVersion).toBe(0);
		history.stop();
	});

	it.each([false, true])(
		'ignores an older-page result from a replaced window: failure=%s',
		async (fail) => {
			let resolveOlder: (value: LocalTranscriptPage) => void = () => {};
			let rejectOlder: (reason: Error) => void = () => {};
			const fetchPage = vi
				.fn()
				.mockResolvedValueOnce(page([10, 11], 10))
				.mockImplementationOnce(
					() =>
						new Promise<LocalTranscriptPage>((resolve, reject) => {
							resolveOlder = resolve;
							rejectOlder = reject;
						})
				)
				.mockResolvedValueOnce(page([98, 99], 98));
			const history = new TranscriptHistory(fetchPage, () => {});
			await history.refresh();
			const older = history.loadOlder();
			await history.refresh();
			if (fail) rejectOlder(new Error('offline'));
			else resolveOlder(page([8, 9], 8));
			await older;
			expect(texts(history)).toEqual(['98', '99']);
			expect(history.nextBefore).toBe(98);
			expect(history.stale).toBe(false);
			expect(history.loadingOlder).toBe(false);
			history.stop();
		}
	);

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

	it('keeps cached output on refresh failure, then retries the latest window', async () => {
		vi.useFakeTimers();
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(page([0, 1]))
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(page([4, 5], 4));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		await history.refresh();
		expect(texts(history)).toEqual(['0', '1']);
		expect(history.stale).toBe(true);
		await vi.runAllTimersAsync();
		expect(texts(history)).toEqual(['4', '5']);
		expect(history.nextBefore).toBe(4);
		expect(fetchPage).toHaveBeenCalledTimes(3);
		history.stop();
	});

	it('assembles a long response split across a 12-part refresh and 40-part prepend', async () => {
		const runId = 'run-long';
		const parts = Array.from({ length: 52 }, (_, number) => completionPart(number, runId));
		const fetchPage = vi.fn(windowedFetch(parts));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		expect(history.messages).toHaveLength(1);
		expect(history.messages[0]?.sourceNumbers).toEqual(
			Array.from({ length: 12 }, (_, index) => 40 + index)
		);
		expect(history.messages[0]?.text).toBe(
			Array.from({ length: 12 }, (_, index) => `t${40 + index}`).join('')
		);
		expect(history.nextBefore).toBe(40);

		await history.loadOlder();
		const fullText = parts.map((part) => part.message?.text).join('');
		expect(history.messages).toHaveLength(1);
		expect(history.messages[0]?.text).toBe(fullText);
		expect(history.messages[0]?.sourceNumbers).toEqual(parts.map((part) => part.number));
		expect(history.messages[0]?.parts).toHaveLength(52);
		expect(history.nextBefore).toBeUndefined();
		expect(fetchPage.mock.calls.map(([request]) => request)).toEqual([
			{ limit: 12 },
			{ before: 40, limit: 40 }
		]);

		await history.refresh();
		expect(history.messages[0]?.text).toBe(fullText);
		expect(history.messages[0]?.sourceNumbers).toEqual(parts.map((part) => part.number));
		expect(
			history.messages[0]?.parts.map((part) => (part.type === 'text' ? part.text : ''))
		).toEqual(parts.map((part) => part.message?.text));
		expect(fetchPage.mock.calls.map(([request]) => request)).toEqual([
			{ limit: 12 },
			{ before: 40, limit: 40 },
			{ limit: 12 }
		]);
		history.stop();
	});

	it('keeps terminal tools across a page boundary until the completion that owns their calls arrives', async () => {
		const runId = 'run-1';
		const older = [
			completionPart(0, runId, { text: 'previous turn' }),
			toolPart(1, runId, [
				{ type: 'tool-call', callId: 'b', name: 'exec_command', input: null, startedAt: 1_100 }
			]),
			toolPart(2, runId, [
				{ type: 'tool-call', callId: 'a', name: 'exec_command', input: null, startedAt: 1_200 }
			]),
			toolPart(3, runId, [
				{ type: 'tool-call', callId: 'a', name: 'exec_command', input: null },
				{
					type: 'tool-result',
					callId: 'a',
					name: 'exec_command',
					output: { status: 'completed' },
					completedAt: 1_800
				}
			])
		];
		const newest = [
			completionPart(4, runId, {
				text: 'checking',
				streamIds: ['stream-4'],
				parts: [
					{ type: 'reasoning', id: 'r', text: '' },
					{ type: 'text', id: 't', text: 'checking' },
					{ type: 'tool-call', callId: 'a', name: 'exec_command', input: null },
					{ type: 'tool-call', callId: 'b', name: 'exec_command', input: null }
				]
			}),
			toolPart(5, runId, [
				{ type: 'tool-call', callId: 'b', name: 'exec_command', input: null },
				{
					type: 'tool-result',
					callId: 'b',
					name: 'exec_command',
					output: { status: 'completed' },
					completedAt: 2_400
				}
			]),
			completionPart(6, runId, { text: 'answer', streamIds: ['stream-6'] })
		];
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(partsPage(newest, 4))
			.mockResolvedValueOnce(partsPage(older));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		await history.loadOlder();
		expect(history.messages).toHaveLength(1);
		expect(history.messages[0]?.parts.map((part) => part.type)).toEqual([
			'text',
			'reasoning',
			'text',
			'tool-call',
			'tool-result',
			'tool-call',
			'tool-result',
			'text'
		]);
		expect(history.messages[0]?.parts[3]).toMatchObject({ callId: 'a', startedAt: 1_200 });
		expect(history.messages[0]?.parts[4]).toMatchObject({ callId: 'a', completedAt: 1_800 });
		expect(history.messages[0]?.parts[5]).toMatchObject({ callId: 'b', startedAt: 1_100 });
		expect(history.messages[0]?.parts[6]).toMatchObject({ callId: 'b', completedAt: 2_400 });
		expect(history.messages[0]?.text).toBe('previous turncheckinganswer');
		history.stop();
	});

	it('applies delayed details only to already-loaded parts and keeps them across lightweight refreshes', async () => {
		const runId = 'run-1';
		const light = (number: number, text: string, reasoning: string) =>
			completionPart(number, runId, {
				text,
				detailsLoaded: false,
				parts: [
					{ type: 'reasoning', id: `r-${number}`, text: reasoning },
					{ type: 'text', id: `t-${number}`, text }
				]
			});
		const detailed = (number: number, text: string, reasoning: string) =>
			completionPart(number, runId, {
				text,
				detailsLoaded: true,
				parts: [
					{ type: 'reasoning', id: `r-${number}`, text: reasoning },
					{ type: 'text', id: `t-${number}`, text }
				]
			});
		let resolveRefresh: (value: LocalTranscriptPage) => void = () => {};
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(partsPage([light(10, 'head', ''), light(11, 'tail', '')], 10))
			.mockImplementationOnce(
				() =>
					new Promise<LocalTranscriptPage>((done) => {
						resolveRefresh = done;
					})
			)
			.mockResolvedValueOnce(partsPage([light(10, 'head', ''), light(11, 'tail', '')], 10));
		const history = new TranscriptHistory(fetchPage, () => {});
		await history.refresh();
		expect(history.messages[0]?.detailsLoaded).toBe(false);
		expect(history.detailsNumbers(history.messages[0]!)).toEqual([10, 11]);

		const pending = history.refresh();
		history.applyDetails([detailed(10, 'head', 'plan'), detailed(99, 'unloaded', 'nope')]);
		expect(history.messages[0]?.parts[0]).toMatchObject({ type: 'reasoning', text: 'plan' });
		expect(history.detailsNumbers(history.messages[0]!)).toEqual([11]);
		expect(history.messages[0]?.detailsLoaded).toBe(false);

		resolveRefresh(partsPage([light(10, 'head', ''), light(11, 'tail', '')], 10));
		await pending;
		expect(history.messages[0]?.parts[0]).toMatchObject({ type: 'reasoning', text: 'plan' });
		expect(history.detailsNumbers(history.messages[0]!)).toEqual([11]);

		history.applyDetails([detailed(11, 'tail', 'more')]);
		expect(history.messages[0]?.detailsLoaded).toBe(true);
		expect(history.detailsNumbers(history.messages[0]!)).toEqual([]);
		expect(
			history.messages[0]?.parts.map((part) => (part.type === 'reasoning' ? part.text : part.type))
		).toEqual(['plan', 'text', 'more', 'text']);

		await history.refresh();
		expect(history.messages[0]?.detailsLoaded).toBe(true);
		expect(history.messages[0]?.parts[0]).toMatchObject({ text: 'plan' });
		expect(history.messages[0]?.parts[2]).toMatchObject({ text: 'more' });
		history.stop();
	});
});
