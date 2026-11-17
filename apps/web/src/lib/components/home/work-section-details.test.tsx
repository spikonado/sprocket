import { expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { fixtureId } from '$lib/convex-test-client';
import { TranscriptStore } from '$lib/home/transcript-store';
import type {
	TranscriptEvent,
	TranscriptRow,
	TranscriptScopeRequest,
	TranscriptSnapshot,
	WatchHandlers
} from '$lib/types/sprocket';
import WorkSectionDetails from './work-section-details';

function snapshot(rows: TranscriptRow[]): TranscriptSnapshot {
	return { type: 'snapshot', rows, nextBefore: null, stale: false };
}

function tool(id: number): Extract<TranscriptRow, { kind: 'tool' }> {
	return {
		id: `tool:${id}`,
		runId: 'run',
		kind: 'tool',
		name: 'exec_command',
		label: 'Run',
		summary: `echo ${id}`,
		hasMore: false,
		status: 'completed'
	};
}

function watch(_request: TranscriptScopeRequest, { signal }: WatchHandlers<TranscriptEvent>) {
	return new Promise<void>((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

function renderWork() {
	const threadId = fixtureId<'threadRecords'>('thread');
	const rowId = 'work:1';

	const row: TranscriptRow = {
		id: rowId,
		runId: 'run',
		kind: 'work',
		toolCounts: {},
		running: true
	};

	const api = {
		fetchTranscriptRows: vi.fn(async () => snapshot([])),
		fetchTranscriptRow: vi.fn(async () => ({ row })),
		watchTranscript: vi.fn(watch),
		watchTranscriptWork: vi.fn(watch),
		watchTranscriptItem: vi.fn(watch)
	};

	const store = new TranscriptStore();
	store.selectThread(threadId);
	onTestFinished(store.watch({ api, userId: 'user', threadId, isCurrent: () => true }));
	api.watchTranscript.mock.calls[0][1].onEvent(snapshot([row]));
	const view = render(<WorkSectionDetails store={store} rowId={rowId} />);
	const { onEvent, signal } = api.watchTranscriptWork.mock.calls[0][1];

	return { ...view, api, threadId, rowId, onEvent, signal };
}

it('subscribes while mounted and appends new work without replacing existing rows', () => {
	const view = renderWork();
	expect(view.api.watchTranscriptWork).toHaveBeenCalledWith(
		{ userId: 'user', threadId: view.threadId, rowId: view.rowId },
		{ signal: expect.any(AbortSignal), onEvent: expect.any(Function) }
	);
	act(() => view.onEvent(snapshot([tool(1)])));
	const original = view.getByText('echo 1');
	act(() => view.onEvent({ type: 'batch', updates: [{ type: 'row', row: tool(2) }] }));
	expect(view.getByText('echo 1')).toBe(original);
	expect(view.getAllByText(/^echo /)).toEqual([original, view.getByText('echo 2')]);

	act(() =>
		view.onEvent({
			type: 'batch',
			updates: [{ type: 'row', row: { ...tool(2), summary: 'echo updated' } }]
		})
	);
	expect(view.getByText('echo updated')).toBeTruthy();
	expect(view.container.querySelectorAll('[data-tool-row]')).toHaveLength(2);
	expect(view.signal.aborted).toBe(false);
	view.unmount();
	expect(view.signal.aborted).toBe(true);
});

it('replaces and reorders work whenever another snapshot arrives', () => {
	const view = renderWork();
	act(() => view.onEvent(snapshot([tool(1), tool(2)])));
	const first = view.getByText('echo 1');
	const second = view.getByText('echo 2');
	act(() => view.onEvent(snapshot([tool(2), tool(1)])));
	expect(view.getAllByText(/^echo /)).toEqual([second, first]);
	act(() => view.onEvent(snapshot([tool(3), tool(2)])));
	expect(view.getAllByText(/^echo /)).toEqual([view.getByText('echo 3'), second]);
});

it('rewatches work from the next cursor when earlier work is requested', () => {
	const view = renderWork();
	act(() => view.onEvent({ ...snapshot([tool(6)]), nextBefore: 5 }));
	fireEvent.click(view.getByRole('button', { name: 'Show earlier' }));
	expect(view.signal.aborted).toBe(true);
	expect(view.api.watchTranscriptWork).toHaveBeenLastCalledWith(
		{ userId: 'user', threadId: view.threadId, rowId: view.rowId, before: 5 },
		{ signal: expect.any(AbortSignal), onEvent: expect.any(Function) }
	);
	const { onEvent } = view.api.watchTranscriptWork.mock.calls[1][1];
	act(() => onEvent(snapshot([tool(5), tool(6)])));
	expect(view.getAllByText(/^echo /).map((element) => element.textContent)).toEqual([
		'echo 5',
		'echo 6'
	]);
	expect(view.queryByRole('button', { name: 'Show earlier' })).toBeNull();
});

it('keeps reasoning expanded when a work batch adds another item', () => {
	const view = renderWork();

	const reasoning: TranscriptRow = {
		id: 'reasoning:1',
		runId: 'run',
		kind: 'reasoning',
		label: 'Reasoned',
		running: false
	};

	act(() => view.onEvent(snapshot([reasoning])));
	fireEvent.click(view.getByRole('button', { name: 'Reasoned' }));
	act(() =>
		view.api.watchTranscriptItem.mock.calls[0][1].onEvent(
			snapshot([{ ...reasoning, text: 'Inspect the workspace.' }])
		)
	);
	const text = view.getByText('Inspect the workspace.');
	act(() => view.onEvent({ type: 'batch', updates: [{ type: 'row', row: tool(1) }] }));
	expect(view.getByText('Inspect the workspace.')).toBe(text);
	expect(view.getByRole('button', { name: 'Reasoned' }).getAttribute('aria-expanded')).toBe('true');
	expect(view.getByText('echo 1')).toBeTruthy();
});
