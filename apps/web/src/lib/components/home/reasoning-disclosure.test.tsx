import { expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { fixtureId } from '$lib/convex-test-client';
import { TranscriptStore } from '$lib/home/transcript-store';
import type {
	TranscriptEvent,
	TranscriptScopeRequest,
	TranscriptSnapshot,
	WatchHandlers
} from '$lib/types/sprocket';
import ReasoningDisclosure from './reasoning-disclosure';

function watch(_request: TranscriptScopeRequest, { signal }: WatchHandlers<TranscriptEvent>) {
	return new Promise<void>((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

it('starts running reasoning closed and streams details only while open', () => {
	const threadId = fixtureId<'threadRecords'>('thread');

	const row = {
		id: 'reasoning:1',
		runId: 'run',
		kind: 'reasoning',
		label: 'Reasoning',
		running: true
	} as const;

	const snapshot: TranscriptSnapshot = {
		type: 'snapshot',
		rows: [row],
		nextBefore: null,
		stale: false
	};

	const api = {
		fetchTranscriptRows: vi.fn(async () => snapshot),
		fetchTranscriptRow: vi.fn(async () => ({ row })),
		watchTranscript: vi.fn(watch),
		watchTranscriptWork: vi.fn(watch),
		watchTranscriptItem: vi.fn(watch)
	};

	const store = new TranscriptStore();
	store.selectThread(threadId);
	onTestFinished(store.watch({ api, userId: 'user', threadId, isCurrent: () => true }));
	api.watchTranscript.mock.calls[0][1].onEvent(snapshot);
	const view = render(<ReasoningDisclosure store={store} rowId={row.id} />);
	const button = view.getByRole('button', { name: 'Reasoning' });

	expect(button.getAttribute('aria-expanded')).toBe('false');
	expect(api.watchTranscriptItem).not.toHaveBeenCalled();
	fireEvent.click(button);
	expect(button.getAttribute('aria-expanded')).toBe('true');
	expect(view.getByRole('status').textContent).toBe('Loading reasoning...');
	expect(api.watchTranscriptItem).toHaveBeenCalledWith(
		{ userId: 'user', threadId, rowId: row.id },
		{ signal: expect.any(AbortSignal), onEvent: expect.any(Function) }
	);
	const { signal, onEvent } = api.watchTranscriptItem.mock.calls[0][1];
	const text = 'Inspect the workspace.';
	act(() => onEvent({ ...snapshot, rows: [{ ...row, text }] }));
	expect(view.getByText(text)).toBeTruthy();
	act(() =>
		onEvent({
			type: 'batch',
			updates: [{ type: 'append', rowId: row.id, offset: text.length, text: ' Then run tests.' }]
		})
	);
	expect(view.getByText('Inspect the workspace. Then run tests.')).toBeTruthy();
	expect(signal.aborted).toBe(false);
	act(() =>
		api.watchTranscript.mock.calls[0][1].onEvent({
			type: 'batch',
			updates: [{ type: 'row', row: { ...row, label: 'Reasoned', running: false } }]
		})
	);
	expect(view.getByRole('button', { name: 'Reasoned' }).getAttribute('aria-expanded')).toBe('true');
	expect(view.getByText('Inspect the workspace. Then run tests.')).toBeTruthy();
	fireEvent.click(button);
	expect(button.getAttribute('aria-expanded')).toBe('false');
	expect(signal.aborted).toBe(true);

	for (const running of [true, false]) {
		act(() =>
			api.watchTranscript.mock.calls[0][1].onEvent({
				type: 'batch',
				updates: [
					{ type: 'row', row: { ...row, label: running ? 'Reasoning' : 'Reasoned', running } }
				]
			})
		);
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(api.watchTranscriptItem).toHaveBeenCalledTimes(1);
	}

	fireEvent.click(view.getByRole('button', { name: 'Reasoned' }));
	expect(api.watchTranscriptItem).toHaveBeenCalledTimes(2);
	act(() =>
		api.watchTranscriptItem.mock.calls[1][1].onEvent({
			...snapshot,
			rows: [{ ...row, label: 'Reasoned', running: false, text: 'Finished inspecting.' }]
		})
	);
	expect(view.getByText('Finished inspecting.')).toBeTruthy();
	view.unmount();
	expect(api.watchTranscriptItem.mock.calls[1][1].signal.aborted).toBe(true);
});
