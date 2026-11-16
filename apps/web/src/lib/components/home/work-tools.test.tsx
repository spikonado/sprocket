import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import { MarkdownFileLinksContext } from '$lib/chat/markdown-file-links';
import { ConvexTestClient, ConvexTestProvider, fixtureId } from '$lib/convex-test-client';
import { TranscriptStore } from '$lib/home/transcript-store';
import type {
	TranscriptEvent,
	TranscriptRow,
	TranscriptScopeRequest,
	TranscriptSnapshot,
	WatchHandlers
} from '$lib/types/sprocket';
import WorkTools from './work-tools';

type ToolRow = Extract<TranscriptRow, { kind: 'tool' }>;

function tool(overrides: Partial<ToolRow> = {}): ToolRow {
	return {
		id: 'tool',
		runId: 'saved-run',
		kind: 'tool',
		name: 'exec_cmd',
		label: 'Server label',
		summary: 'Server summary',
		hasMore: false,
		status: 'completed',
		...overrides
	};
}

function snapshot(row: ToolRow): TranscriptSnapshot {
	return { type: 'snapshot', rows: [row], nextBefore: null, stale: false };
}

function watch(_request: TranscriptScopeRequest, { signal }: WatchHandlers<TranscriptEvent>) {
	return new Promise<void>((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

function transcript(row: ToolRow, detail: ToolRow = row) {
	const api = {
		fetchTranscriptRows: vi.fn(async () => snapshot(row)),
		fetchTranscriptRow: vi.fn(async () => ({ row })),
		watchTranscript: vi.fn(watch),
		watchTranscriptWork: vi.fn(watch),
		watchTranscriptItem: vi.fn(
			(
				request: TranscriptScopeRequest & { rowId: string },
				handlers: WatchHandlers<TranscriptEvent>
			) => {
				handlers.onEvent(snapshot(detail));

				return watch(request, handlers);
			}
		)
	};

	const store = new TranscriptStore();
	vi.spyOn(store, 'openItem');
	onTestFinished(
		store.watch({
			api,
			userId: 'user',
			threadId: fixtureId<'threadRecords'>('thread'),
			isCurrent: () => true
		})
	);
	api.watchTranscript.mock.calls[0][1].onEvent(snapshot(row));

	function update(next: ToolRow, full = false) {
		const handlers = full
			? api.watchTranscriptItem.mock.calls.at(-1)![1]
			: api.watchTranscript.mock.calls[0][1];

		handlers.onEvent({ type: 'batch', updates: [{ type: 'row', row: next }] });
	}

	return { store, api, update, props: { store, rowId: row.id } };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('tool rows', () => {
	it('renders every polled target with its own command and failure', () => {
		const row = tool({
			name: 'poll_cmd',
			targets: [
				{ summary: 'bun run build', command: 'bun run build', status: 'completed' },
				{ summary: 'Session missing', status: 'failed', error: 'Unknown session.' }
			]
		});

		const { props } = transcript(row);
		const view = render(<WorkTools {...props} />);

		expect(view.container.querySelectorAll('[data-tool-row]')).toHaveLength(2);
		expect(within(view.container).getByText('bun run build')).toBeTruthy();
		expect(within(view.container).getByRole('status').textContent).toBe('Unknown session.');
		expect(within(view.container).getByText('(failed)')).toBeTruthy();
	});

	it('subscribes to full summary only while expanded and releases it on unmount', () => {
		const row = tool({ hasMore: true });
		const full = tool({ summary: 'Full command\nwith output' });
		const { store, api, update, props } = transcript(row, full);
		const view = render(<WorkTools {...props} />);
		const summary = within(view.container).getByRole('button');
		expect(store.openItem).not.toHaveBeenCalled();

		fireEvent.click(summary);
		expect(store.openItem).toHaveBeenCalledExactlyOnceWith(row.id);
		const firstSignal = api.watchTranscriptItem.mock.calls[0][1].signal;
		expect(firstSignal.aborted).toBe(false);
		expect(view.container.querySelector('p')?.textContent).toBe(full.summary);
		act(() => update({ ...full, summary: 'Live full summary' }, true));
		expect(view.container.querySelector('p')?.textContent).toBe('Live full summary');

		fireEvent.click(summary);
		expect(firstSignal.aborted).toBe(true);
		expect(view.container.querySelector('p')).toBeNull();
		fireEvent.click(summary);
		const secondSignal = api.watchTranscriptItem.mock.calls[1][1].signal;
		expect(secondSignal.aborted).toBe(false);
		view.unmount();
		expect(secondSignal.aborted).toBe(true);
	});

	it('makes visually truncated and multiline summaries expandable', () => {
		let resize = () => {};

		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(callback: () => void) {
					resize = callback;
				}
				observe() {}
				disconnect() {}
			}
		);
		const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(0);
		const { store, update, props } = transcript(tool());
		const view = render(<WorkTools {...props} />);
		expect(within(view.container).queryByRole('button')).toBeNull();
		width.mockReturnValue(100);
		act(() => resize());
		expect(within(view.container).getByRole('button').getAttribute('aria-expanded')).toBe('false');
		width.mockReturnValue(0);
		act(() => resize());
		expect(within(view.container).queryByRole('button')).toBeNull();
		act(() => update(tool({ summary: 'first\nsecond' })));
		expect(within(view.container).getByRole('button')).toBeTruthy();
		fireEvent.click(within(view.container).getByRole('button'));
		expect(store.openItem).not.toHaveBeenCalled();
	});

	it('shows the full summary of tools that do not expand in a title', () => {
		const { store, props } = transcript(tool({ name: 'web_search', hasMore: true }));
		const view = render(<WorkTools {...props} />);
		expect(within(view.container).queryByRole('button')).toBeNull();
		expect(view.container.querySelector('[data-tool-row]')?.getAttribute('title')).toBe(
			'Server summary…'
		);
		expect(store.openItem).not.toHaveBeenCalled();
	});

	it.each(['running', 'completed', 'failed', 'cancelled', 'interrupted'] as const)(
		'preserves server text and %s status',
		(status) => {
			const row = tool({
				name: 'apply_patch',
				summary: 'a.ts\nb.ts',
				status,
				error: 'Exact error'
			});

			const { props } = transcript(row);
			const view = render(<WorkTools {...props} />);
			const rows = view.container.querySelectorAll('[data-tool-row]');
			expect(rows).toHaveLength(1);

			const suffix =
				status === 'cancelled'
					? '(stopped)'
					: status === 'failed' || status === 'interrupted'
						? `(${status})`
						: '';

			expect(rows[0].textContent).toBe(`${row.label}:${row.summary}${suffix}`);
			expect(within(view.container).getByRole('status').textContent).toBe(row.error);
		}
	);

	it('updates just the subscribed row', () => {
		const first = transcript(tool());
		const second = transcript(tool({ id: 'other' }));

		const view = render(
			<>
				<WorkTools {...first.props} />
				<WorkTools {...second.props} />
			</>
		);

		act(() => first.update(tool({ summary: 'Updated summary', status: 'running' })));
		const rows = view.container.querySelectorAll('[data-tool-row]');
		expect(rows[0].textContent).toBe('Server label:Updated summary');
		expect(rows[1].textContent).toBe('Server label:Server summary');
	});

	it('opens the parsed file from its row without loading details', () => {
		const { store, props } = transcript(
			tool({
				name: 'parse_file',
				hasMore: true,
				action: { kind: 'openFile', path: '/repo/docs/design.pdf' }
			})
		);

		const open = vi.fn();

		const view = render(
			<MarkdownFileLinksContext value={{ roots: ['/repo'], open }}>
				<WorkTools {...props} />
			</MarkdownFileLinksContext>
		);

		fireEvent.click(within(view.container).getByRole('button'));
		expect(store.openItem).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledWith({
			workspacePath: '/repo',
			path: 'docs/design.pdf',
			knownDirectory: false
		});
	});

	it('shows the save-card action after reload without loading details', () => {
		const { store, props } = transcript(tool({ action: { kind: 'saveCard' } }));

		const view = render(
			<ConvexTestProvider client={new ConvexTestClient()}>
				<WorkTools {...props} />
			</ConvexTestProvider>
		);

		expect(within(view.container).getByRole('button', { name: 'Save a card' })).toBeTruthy();
		expect(store.openItem).not.toHaveBeenCalled();
	});

	it('uses the summary as the whole display when the server omits a label', () => {
		const { props } = transcript(tool({ label: undefined, summary: 'echo hello' }));
		const view = render(<WorkTools {...props} />);
		expect(view.container.querySelector('[data-tool-row]')?.textContent).toBe('echo hello');
	});
});
