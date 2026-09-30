import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import {
	TranscriptReplica,
	useTranscriptReplica,
	type TranscriptReplicaApi
} from '$lib/home/transcript-replica';
import type {
	LiveCompletionOverlay,
	LiveCompletionWatchEvent,
	TranscriptDisplayPage,
	TranscriptDisplayRow,
	TranscriptWatchEvent
} from '$lib/types/sprocket';

function threadId(value: string): Id<'threadRecords'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadRecords'>;
}

function runId(value: string): Id<'runs'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'runs'>;
}

function displayRow(sequence: number): TranscriptDisplayRow {
	return {
		id: `row-${sequence}`,
		threadId: threadId('thread-a'),
		runId: runId('run-a'),
		sequence,
		kind: 'text',
		text: 'Working',
		itemCount: 0,
		pendingTools: 0,
		closed: true,
		revision: sequence
	};
}

function createFakeApi() {
	const displayEvents: Array<(event: TranscriptWatchEvent) => void> = [];
	const liveEvents: Array<(event: LiveCompletionWatchEvent) => void> = [];
	const api: TranscriptReplicaApi = {
		// Never resolves: the replica stays in its initial loading window.
		fetchTranscriptDisplay: () => new Promise<TranscriptDisplayPage>(() => {}),
		watchTranscript: async (_request, handlers) => {
			displayEvents.push(handlers.onEvent);
		},
		watchLiveCompletion: async (_request, handlers) => {
			liveEvents.push(handlers.onEvent);
		}
	};
	return { api, displayEvents, liveEvents };
}

const overlay = (streamId: string): LiveCompletionOverlay => ({
	threadId: threadId('thread-a'),
	runId: runId('run-1'),
	runStatus: 'running',
	streamId,
	text: 'Working',
	parts: [],
	runStartedAt: 1
});

it('clears the previous thread window and notifies subscribers on selection', () => {
	const replica = new TranscriptReplica();
	const listener = vi.fn<() => void>();
	replica.subscribe(listener);
	replica.messages = [displayRow(1)];
	replica.stale = true;
	replica.error = 'old error';
	replica.windowVersion = 4;
	replica.pendingCompletions = [overlay('stream-1')];

	replica.selectThread(threadId('thread-b'));

	expect(listener).toHaveBeenCalledTimes(1);
	expect(replica).toMatchObject({
		threadId: threadId('thread-b'),
		messages: [],
		stale: false,
		error: null,
		windowVersion: 0,
		pendingCompletions: [],
		liveCompletion: null,
		nextBefore: null,
		loading: true
	});

	replica.selectThread(null);
	expect(replica.loading).toBe(false);
	expect(replica.getSnapshot()).toBe(2);
});

it('drops transcript events that arrive after the selected thread changed', async () => {
	const { api, displayEvents } = createFakeApi();
	const replica = new TranscriptReplica();
	let selected = threadId('thread-a');
	replica.selectThread(selected);

	const stop = replica.watchDisplay({
		api,
		userId: 'user-a',
		threadId: selected,
		isCurrent: () => selected === threadId('thread-a')
	});
	await waitFor(() => expect(displayEvents).toHaveLength(1));

	replica.selectThread(threadId('thread-b'));
	selected = threadId('thread-b');
	await act(async () => {
		displayEvents[0]({ eventType: 'replaced', stale: true });
	});
	expect(replica.stale).toBe(false);

	stop();
});

it('tracks and clears the live completion stream and notifies subscribers', async () => {
	const { api, liveEvents } = createFakeApi();
	const replica = new TranscriptReplica();
	const listener = vi.fn<() => void>();
	replica.subscribe(listener);
	const tid = threadId('thread-a');
	replica.selectThread(tid);

	const stop = replica.watchLiveCompletion({
		api,
		userId: 'user-a',
		threadId: tid,
		isCurrent: () => true
	});
	await waitFor(() => expect(liveEvents).toHaveLength(1));
	listener.mockClear();

	act(() => {
		liveEvents[0]({ eventType: 'updated', live: overlay('stream-1') });
	});
	expect(replica.liveCompletion?.streamId).toBe('stream-1');
	expect(replica.overlays.map((entry) => entry.streamId)).toEqual(['stream-1']);
	expect(listener).toHaveBeenCalledTimes(1);

	act(() => {
		liveEvents[0]({ eventType: 'cleared' });
	});
	expect(replica.liveCompletion).toBeNull();
	expect(listener).toHaveBeenCalledTimes(2);

	stop();
});

it('withholds visible messages for other threads and accounts', () => {
	const replica = new TranscriptReplica();
	replica.selectThread(threadId('thread-a'));

	expect(
		replica.visibleMessages({ threadId: threadId('thread-b'), userId: 'user-a', run: null })
	).toEqual([]);
	expect(
		replica.visibleMessages({ threadId: threadId('thread-a'), userId: null, run: null })
	).toEqual([]);
	expect(
		replica.visibleMessages({ threadId: threadId('thread-a'), userId: 'user-a', run: null })
	).toEqual([]);
});

it('keeps one replica per mount and re-renders on changes', () => {
	const { result, rerender } = renderHook(() => useTranscriptReplica());
	const replica = result.current;

	rerender();
	expect(result.current).toBe(replica);

	act(() => {
		replica.selectThread(threadId('thread-a'));
	});
	expect(result.current.threadId).toBe(threadId('thread-a'));
});
