import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { fixtureId } from '$lib/convex-test-client';
import { TranscriptStore, type TranscriptStoreApi } from '$lib/home/transcript-store';
import type { TranscriptEvent, TranscriptRow, WatchHandlers } from '$lib/types/sprocket';
import ThreadTranscript from './thread-transcript';

type Props = React.ComponentProps<typeof ThreadTranscript>;

type Watch = WatchHandlers<TranscriptEvent>;

const stops: Array<() => void> = [];
let resize: () => void;

function prompt(number: number): Extract<TranscriptRow, { kind: 'prompt' }> {
	return {
		id: `prompt:${number}`,
		runId: 'run',
		kind: 'prompt',
		text: `Message ${number}`,
		attachments: []
	};
}

function snapshot(rows: TranscriptRow[]): TranscriptEvent {
	return { type: 'snapshot', rows, nextBefore: null, stale: false };
}

function waitForAbort({ signal }: Watch) {
	return new Promise<void>((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

function transcript(rows: TranscriptRow[], activeRunId: Props['activeRunId'] = 'run') {
	const threads: Watch[] = [];
	const works: Watch[] = [];
	const items: Watch[] = [];

	const api: TranscriptStoreApi = {
		fetchTranscriptRows: vi.fn(),
		fetchTranscriptRow: vi.fn(),
		watchTranscript: vi.fn((_scope, handlers) => {
			threads.push(handlers);

			return waitForAbort(handlers);
		}),
		watchTranscriptWork: vi.fn((_scope, handlers) => {
			works.push(handlers);

			return waitForAbort(handlers);
		}),
		watchTranscriptItem: vi.fn((_scope, handlers) => {
			items.push(handlers);

			return waitForAbort(handlers);
		})
	};

	const store = new TranscriptStore();

	function connect() {
		stops.push(
			store.watch({
				api,
				userId: 'user',
				threadId: fixtureId<'threadRecords'>('thread'),
				isCurrent: () => true
			})
		);
	}

	connect();
	threads[0].onEvent(snapshot(rows));
	const props: Props = { store, activeRunId, project: null, onLoadOlder: vi.fn() };
	const view = render(<ThreadTranscript {...props} />);

	return {
		...view,
		api,
		props,
		works,
		items,
		viewport: view.getByRole('region', { name: 'Conversation history' }),
		connect,
		emit(event: TranscriptEvent) {
			act(() => threads.at(-1)!.onEvent(event));
		},
		setProps(patch: Partial<Props>) {
			Object.assign(props, patch);
			view.rerender(<ThreadTranscript {...props} />);
		}
	};
}

function scrollLayout() {
	const selector = '[aria-label="Conversation history"]';
	const viewportHeight = 600;
	const rowHeight = 300;

	const anchors = (viewport: Element) => [
		...viewport.querySelectorAll<HTMLElement>('[data-transcript-anchor]')
	];

	let scrollTop = 0;
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		return this.matches(selector) ? viewportHeight : 0;
	});
	vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		return this.matches(selector) ? Math.max(viewportHeight, anchors(this).length * rowHeight) : 0;
	});
	vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		return this.matches(selector) ? Math.min(scrollTop, this.scrollHeight - this.clientHeight) : 0;
	});
	vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (
		this: HTMLElement,
		top: number
	) {
		if (this.matches(selector))
			scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
	});
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement
	) {
		const viewport = this.closest<HTMLElement>(selector);
		const index = viewport ? anchors(viewport).indexOf(this) : -1;

		return new DOMRect(
			0,
			viewport && index >= 0 ? index * rowHeight - viewport.scrollTop : 0,
			800,
			index < 0 ? viewportHeight : rowHeight
		);
	});
}

function scrollTo(viewport: HTMLElement, top: number) {
	viewport.scrollTop = top;
	fireEvent.scroll(viewport);
}

beforeEach(() => {
	vi.clearAllMocks();
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
});

afterEach(() => {
	act(() => {
		for (const stop of stops.splice(0)) stop();
	});
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it('renders projected prompts and streaming text, and replaces rows on later snapshots', () => {
	const view = transcript([
		{ ...prompt(1), text: 'Explain **this**' },
		{ id: 'text', runId: 'run', kind: 'text', text: 'An *answer*', running: true }
	]);

	expect(view.getByText('this').tagName).toBe('STRONG');
	expect(view.getByRole('log').textContent?.trim()).toBe('An answer');
	view.emit(
		snapshot([
			{ id: 'replacement', runId: 'run', kind: 'text', text: 'Final answer', running: false }
		])
	);
	expect(view.getByText('Final answer')).toBeTruthy();
	expect(view.viewport.querySelectorAll('[data-transcript-anchor]')).toHaveLength(1);
});

it.each([true, false])(
	'defaults running=%s work to the matching expansion and subscribes only while open',
	(running) => {
		const view = transcript([
			{ id: 'work', runId: 'run', kind: 'work', toolCounts: { exec_cmd: 2 }, running }
		]);

		const button = view.getByRole('button', { name: 'Ran 2 commands' });
		expect(button.getAttribute('aria-expanded')).toBe(String(running));
		expect(view.api.watchTranscriptWork).toHaveBeenCalledTimes(running ? 1 : 0);

		if (!running) fireEvent.click(button);
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(view.api.watchTranscriptWork).toHaveBeenCalledWith(
			expect.objectContaining({ rowId: 'work' }),
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
		fireEvent.click(button);
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(view.works[0].signal.aborted).toBe(true);
	}
);

it('uses authoritative lifecycle for unresolved calls running on another machine', () => {
	const work: TranscriptRow = {
		id: 'work',
		runId: 'remote-run',
		kind: 'work',
		toolCounts: { exec_cmd: 1 },
		running: true
	};

	const tool: TranscriptRow = {
		id: 'tool',
		runId: 'remote-run',
		kind: 'tool',
		name: 'exec_cmd',
		summary: 'remote command',
		status: 'running',
		hasMore: false
	};

	const view = transcript([work], 'remote-run');
	expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true');
	act(() => view.works[0].onEvent(snapshot([tool])));
	expect(view.getByText('remote command')).toBeTruthy();
	expect(view.queryByText('(interrupted)')).toBeNull();

	view.rerender(<ThreadTranscript {...view.props} activeRunId={undefined} />);
	expect(view.queryByText('(interrupted)')).toBeNull();
	view.rerender(<ThreadTranscript {...view.props} activeRunId={null} />);
	expect(view.getByText('(interrupted)')).toBeTruthy();
	expect(view.getByText('The agent stopped before this tool call finished.')).toBeTruthy();
	act(() => view.works[0].onEvent(snapshot([{ ...tool, status: 'completed' }])));
	expect(view.queryByText('(interrupted)')).toBeNull();
});

it('reopens work and item subscriptions after reconnect without losing manual expansion', () => {
	const work: TranscriptRow = {
		id: 'work',
		runId: 'run',
		kind: 'work',
		toolCounts: {},
		running: false
	};

	const reasoning: TranscriptRow = {
		id: 'reasoning',
		runId: 'run',
		kind: 'reasoning',
		label: 'Plan',
		running: false
	};

	const view = transcript([work]);
	fireEvent.click(view.getByRole('button', { name: 'Reasoned' }));
	act(() => view.works[0].onEvent(snapshot([reasoning])));
	fireEvent.click(view.getByRole('button', { name: 'Plan' }));
	act(() => view.items[0].onEvent(snapshot([{ ...reasoning, text: 'Initial plan' }])));
	expect(view.getByText('Initial plan')).toBeTruthy();

	act(() => view.connect());
	expect(view.works[0].signal.aborted).toBe(true);
	expect(view.items[0].signal.aborted).toBe(true);
	view.emit(snapshot([work]));
	expect(view.getByRole('button', { name: 'Reasoned' }).getAttribute('aria-expanded')).toBe('true');
	expect(view.works).toHaveLength(2);
	act(() => view.works[1].onEvent(snapshot([reasoning])));
	expect(view.getByRole('button', { name: 'Plan' }).getAttribute('aria-expanded')).toBe('true');
	expect(view.items).toHaveLength(2);
	act(() => view.items[1].onEvent(snapshot([{ ...reasoning, text: 'Restored plan' }])));
	expect(view.getByText('Restored plan')).toBeTruthy();
});

it('streams text appends alongside an unchanged prompt', () => {
	const view = transcript([
		prompt(1),
		{ id: 'text', runId: 'run', kind: 'text', text: 'Hello', running: true }
	]);

	const promptElement = view.getByText('Message 1');

	view.emit({
		type: 'batch',
		updates: [{ type: 'append', rowId: 'text', offset: 5, text: ' world' }]
	});
	expect(view.getByRole('log').textContent?.trim()).toBe('Hello world');
	expect(view.getByText('Message 1')).toBe(promptElement);
});

it('follows output at the bottom and resumes after the reader scrolls back down', () => {
	scrollLayout();
	const view = transcript([1, 2, 3, 4].map(prompt));

	const add = (number: number) =>
		view.emit({ type: 'batch', updates: [{ type: 'row', row: prompt(number) }] });

	expect(view.viewport.scrollTop).toBe(600);
	add(5);
	expect(view.viewport.scrollTop).toBe(900);
	scrollTo(view.viewport, 500);
	add(6);
	act(() => resize());
	expect(view.viewport.scrollTop).toBe(500);
	scrollTo(view.viewport, 1200);
	add(7);
	expect(view.viewport.scrollTop).toBe(1500);
});

it('preserves the visible row offset when older projected rows are prepended', () => {
	scrollLayout();
	const view = transcript([3, 4, 5, 6].map(prompt));
	scrollTo(view.viewport, 150);
	const anchor = view.viewport.querySelector<HTMLElement>('[data-transcript-anchor="prompt:3"]')!;
	const offset = anchor.getBoundingClientRect().top;

	view.emit(snapshot([1, 2, 3, 4, 5, 6].map(prompt)));
	expect(anchor.isConnected).toBe(true);
	expect(anchor.getBoundingClientRect().top).toBe(offset);
	expect(view.viewport.scrollTop).toBe(750);
});

it('prefetches three viewports ahead and requests each cursor only once', () => {
	scrollLayout();
	const view = transcript([1, 2, 3, 4, 5, 6, 7, 8, 9].map(prompt));
	view.setProps({ nextBefore: 3 });
	scrollTo(view.viewport, 1801);
	expect(view.props.onLoadOlder).not.toHaveBeenCalled();
	scrollTo(view.viewport, 1800);
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(1);
	fireEvent.wheel(view.viewport, { deltaY: -1 });
	act(() => resize());
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(1);
	view.setProps({ loadingOlder: true, nextBefore: 2 });
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(1);
	view.setProps({ loadingOlder: false });
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(2);
});

it('bounds short-history prefetch until the reader asks to move upward', () => {
	scrollLayout();
	const view = transcript([prompt(1)]);

	for (const nextBefore of [4, 3, 2, 1]) view.setProps({ nextBefore });
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(3);
	fireEvent.keyDown(view.viewport, { key: 'PageUp' });
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(4);
});

it('makes a failed older-page cursor eligible after the request ends', () => {
	scrollLayout();
	const view = transcript([prompt(1)]);
	view.setProps({ nextBefore: 4 });
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(1);
	view.setProps({ loadingOlder: true });
	view.setProps({ loadingOlder: false });
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(2);
});

it('loads older pages when the newest window contains only hidden prompts', () => {
	scrollLayout();
	const view = transcript([]);
	view.setProps({ nextBefore: 4 });
	expect(view.props.onLoadOlder).toHaveBeenCalledOnce();
});

it('resets history prefetch after reconnecting to the same newest window', () => {
	scrollLayout();
	const view = transcript([prompt(1)]);
	view.setProps({ nextBefore: 4 });
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(1);
	act(() => view.connect());
	view.setProps({ nextBefore: undefined });
	view.emit(snapshot([prompt(1)]));
	view.setProps({ nextBefore: 4 });
	expect(view.props.onLoadOlder).toHaveBeenCalledTimes(2);
});
