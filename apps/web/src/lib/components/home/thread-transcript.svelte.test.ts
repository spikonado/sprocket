import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import type { Id } from '$convex/_generated/dataModel';
import type {
	TranscriptMessage,
	TranscriptDisplayDetails,
	TranscriptDisplayRow,
	LiveTranscriptMessage
} from '$lib/types/sprocket';
import ThreadTranscript from './thread-transcript.svelte';

let cleanup: (() => Promise<void>) | undefined;
let resize: () => void;

function message(number: number): TranscriptDisplayRow {
	return {
		id: `prompt:${number}`,
		// SAFETY: Fixture IDs never leave the mounted component.
		threadId: 'thread' as Id<'threadRecords'>,
		// SAFETY: Fixture IDs never leave the mounted component.
		runId: `run-${number}` as Id<'runs'>,
		kind: 'prompt',
		text: `Message ${number}`,
		attachments: [],
		sequence: number,
		itemCount: 0,
		pendingTools: 0,
		closed: true,
		revision: 1
	};
}

function liveMessage(): LiveTranscriptMessage {
	return {
		kind: 'live',
		id: 'response:run',
		threadId: message(3).threadId,
		runId: message(3).runId,
		runStatus: 'completed',
		runStartedAt: 1,
		text: '',
		parts: []
	};
}

async function settle() {
	flushSync();
	await tick();
	await vi.advanceTimersByTimeAsync(16);
}

async function renderTranscript(messages: TranscriptMessage[], viewportHeight = 600) {
	const props = $state<ComponentProps<typeof ThreadTranscript>>({
		currentError: null,
		runError: null,
		messages,
		actions: [],
		activeRunId: null,
		project: null,
		nextBefore: messages.length ? 3 : undefined,
		onLoadOlder: vi.fn()
	});
	const component = mount(ThreadTranscript, { target: document.body, props });
	cleanup = () => unmount(component);
	const viewport = document.querySelector<HTMLDivElement>('[aria-label="Conversation history"]');
	if (!viewport) throw new Error('Missing transcript viewport');
	const messageElements = () => [
		...viewport.querySelectorAll<HTMLElement>('[data-transcript-anchor]')
	];
	let scrollTop = 0;
	// jsdom has no layout. Model fixed-height rows while exercising the real DOM and effects.
	Object.defineProperties(viewport, {
		clientHeight: { get: () => viewportHeight },
		scrollHeight: {
			configurable: true,
			get: () => Math.max(viewportHeight, messageElements().length * 300)
		},
		scrollTop: {
			configurable: true,
			get: () => {
				scrollTop = Math.min(scrollTop, viewport.scrollHeight - viewport.clientHeight);
				return scrollTop;
			},
			set: (top: number) => {
				scrollTop = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight));
			}
		}
	});
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement
	) {
		const index = messageElements().indexOf(this);
		return new DOMRect(
			0,
			index < 0 ? 0 : index * 300 - viewport.scrollTop,
			800,
			index < 0 ? viewportHeight : 300
		);
	});
	await settle();
	return {
		props,
		viewport,
		scrollTo(top: number) {
			viewport.scrollTop = top;
			viewport.dispatchEvent(new Event('scroll'));
		}
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe = vi.fn();
			disconnect = vi.fn();
		}
	);
});
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('transcript viewport paging', () => {
	it('scrolls vertically without allowing the transcript viewport to scroll horizontally', async () => {
		const { viewport } = await renderTranscript([message(1)]);

		expect(viewport.classList.contains('overflow-y-auto')).toBe(true);
		expect(viewport.classList.contains('overflow-x-hidden')).toBe(true);
		expect(viewport.classList.contains('overflow-auto')).toBe(false);
	});

	it.each(['live', 'persisted'] as const)(
		'uses the same patch and failure disclosures for %s tools',
		async (kind) => {
			const parts: LiveTranscriptMessage['parts'] = [
				{
					type: 'tool-call',
					callId: 'patch',
					name: 'apply_patch',
					input: {
						patch:
							'*** Begin Patch\n*** Add File: a.txt\n+a\n*** Add File: b.txt\n+b\n*** Add File: c.txt\n+c\n*** End Patch'
					}
				},
				{ type: 'tool-result', callId: 'patch', name: 'apply_patch', output: {} },
				{
					type: 'tool-call',
					callId: 'cancelled',
					name: 'exec_command',
					input: { cmd: 'sleep 10' }
				},
				{
					type: 'tool-result',
					callId: 'cancelled',
					name: 'exec_command',
					output: { status: 'cancelled', error: 'stopped by user' }
				},
				{ type: 'tool-call', callId: 'interrupted', name: 'read_skill', input: { name: 'test' } }
			];
			const response: TranscriptMessage =
				kind === 'live'
					? { ...liveMessage(), parts }
					: {
							...message(3),
							kind: 'work',
							id: 'work-3',
							itemCount: 3
						};
			const { props, viewport } = await renderTranscript([response]);
			props.loadSectionDetails = vi
				.fn()
				.mockResolvedValue({ parts, revision: 1, stale: false, indexing: false });
			await settle();
			viewport.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click();
			await settle();
			const patch = [...viewport.querySelectorAll('button')].find((button) =>
				button.textContent?.includes('Changed Files')
			);
			expect(patch?.getAttribute('aria-expanded')).toBe('false');
			const failures = [...viewport.querySelectorAll('details summary')];
			expect(failures.map((summary) => summary.textContent)).toEqual([
				expect.stringContaining('(cancelled)'),
				expect.stringContaining('(interrupted)')
			]);
			expect(failures.every((summary) => summary.querySelector('.text-amber-800'))).toBe(true);
			expect(viewport.querySelector('details [role="status"]')?.textContent).toBe(
				'stopped by user'
			);
		}
	);

	it.each(['live', 'persisted'] as const)(
		'shows an open running-command group for %s tools',
		async (kind) => {
			const parts: LiveTranscriptMessage['parts'] = [
				{ type: 'tool-call', callId: 'command', name: 'exec_command', input: { cmd: 'sleep 10' } },
				{
					type: 'tool-result',
					callId: 'command',
					name: 'exec_command',
					output: { sessionId: 'session', running: true }
				}
			];
			const response: TranscriptMessage =
				kind === 'live'
					? { ...liveMessage(), runStatus: 'running', parts }
					: {
							...message(3),
							kind: 'work',
							id: 'work-3',
							itemCount: 1,
							closed: false,
							pendingTools: 1
						};
			const { props, viewport } = await renderTranscript([response]);
			props.activeRunId = response.runId;
			props.loadSectionDetails = vi
				.fn()
				.mockResolvedValue({ parts, revision: 1, stale: false, indexing: false });
			await settle();
			const running = [...viewport.querySelectorAll('button')].find((button) =>
				button.textContent?.includes('Running')
			);
			expect(running?.getAttribute('aria-expanded')).toBe('true');
			expect(running?.querySelector('.animate-spin')).not.toBeNull();
			expect(viewport.querySelector('[title="sleep 10 (running)"]')).not.toBeNull();
		}
	);

	it('keeps long work sections as summaries and fetches a bounded page only after expansion', async () => {
		const summary = (number: number): TranscriptDisplayRow => ({
			...message(number),
			id: `work-${number}`,
			kind: 'work',
			text: '',
			itemCount: 4_000,
			startedAt: 1_000,
			completedAt: 3_001_000
		});
		const first = summary(1);
		const { props, viewport } = await renderTranscript([message(0), first, summary(2)]);
		let edgeVisible = false;
		const geometry = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation();
		if (!geometry) throw new Error('Missing viewport geometry');
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement
		) {
			return this.hasAttribute('data-work-edge')
				? new DOMRect(0, edgeVisible ? 500 : 1000, 800, 1)
				: geometry.call(this);
		});
		const load = vi
			.fn()
			.mockResolvedValueOnce({
				parts: [{ type: 'reasoning', id: 'detail', text: 'Requested detail' }],
				nextAfter: 5,
				revision: 1,
				stale: false,
				indexing: false
			})
			.mockImplementation(() => new Promise(() => {}));
		props.loadSectionDetails = load;
		await settle();
		expect(load).not.toHaveBeenCalled();
		expect(viewport.querySelectorAll('[data-transcript-anchor]')).toHaveLength(3);
		const buttons = [...viewport.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
			button.textContent?.includes('Worked for')
		);
		expect(buttons.map((button) => button.textContent?.trim())).toEqual([
			'Worked for 50m 0s',
			'Worked for 50m 0s'
		]);
		buttons[0].click();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		expect(load.mock.calls[0][0].id).toBe(first.id);
		expect(load.mock.calls[0][1]).toEqual({});
		expect(viewport.textContent).not.toMatch(/Next details|Previous details/);
		edgeVisible = true;
		viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
		await settle();
		expect(load.mock.calls[1][1]).toEqual({ after: 5 });
		const signal: AbortSignal = load.mock.calls[1][2];
		buttons[0].click();
		await settle();
		expect(signal.aborted).toBe(true);
		expect(viewport.textContent).not.toContain('Next details');
	});

	it.each([false, true])(
		'anchors the visible tool after prepending, including movement during the request: %s',
		async (moveWhileLoading) => {
			const work: TranscriptDisplayRow = {
				...message(2),
				id: 'work',
				kind: 'work',
				itemCount: 10,
				closed: false
			};
			const { props, viewport, scrollTo } = await renderTranscript([
				message(0),
				message(1),
				work,
				message(3)
			]);
			props.nextBefore = undefined;
			const rows = () =>
				[...viewport.querySelectorAll<HTMLElement>('[data-work-detail]')].filter(
					(element) => !element.querySelector('[data-work-detail]')
				);
			Object.defineProperty(viewport, 'scrollHeight', { get: () => 1200 + rows().length * 100 });
			let olderVisible = false;
			vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
				this: HTMLElement
			) {
				if (this === viewport) return new DOMRect(0, 0, 800, 600);
				if (this.hasAttribute('data-work-edge'))
					return new DOMRect(
						0,
						olderVisible && this.dataset.workEdge === 'older' ? 100 : 1000,
						800,
						1
					);
				const details = rows();
				const detailIndex = details.indexOf(this);
				if (detailIndex >= 0)
					return new DOMRect(0, 650 + detailIndex * 100 - viewport.scrollTop, 800, 100);
				const index = [...viewport.querySelectorAll('[data-transcript-anchor]')].indexOf(this);
				return new DOMRect(
					0,
					index * 300 + (index === 3 ? details.length * 100 : 0) - viewport.scrollTop,
					800,
					300
				);
			});
			function page(ids: number[], previousBefore?: number): TranscriptDisplayDetails {
				return {
					parts: ids.flatMap((id) => [
						{
							type: 'tool-call' as const,
							callId: String(id),
							name: 'exec_command',
							input: { cmd: `echo ${id}` }
						},
						{ type: 'tool-result' as const, callId: String(id), name: 'exec_command', output: {} }
					]),
					previousBefore,
					revision: 1,
					indexing: false,
					stale: false
				};
			}
			let resolve!: (value: TranscriptDisplayDetails) => void;
			const load = vi
				.fn()
				.mockResolvedValueOnce(page([6, 7], 6))
				.mockImplementation(
					() =>
						new Promise<TranscriptDisplayDetails>((done) => {
							resolve = done;
						})
				);
			props.loadSectionDetails = load;
			props.activeRunId = work.runId;
			await settle();
			expect(load).toHaveBeenCalledTimes(1);
			scrollTo(700);
			const anchor = rows()[0];
			olderVisible = true;
			viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }));
			await settle();
			expect(load.mock.calls[1][1]).toEqual({ before: 6 });
			if (moveWhileLoading) scrollTo(660);
			const offset = anchor.getBoundingClientRect().top;
			resolve(page([4, 5]));
			await settle();
			expect(anchor.isConnected).toBe(true);
			expect(anchor.getBoundingClientRect().top).toBe(offset);
			expect(viewport.scrollTop).toBe(moveWhileLoading ? 860 : 900);
			resize();
			expect(viewport.scrollTop).toBe(moveWhileLoading ? 860 : 900);
		}
	);

	it('fills an initially empty thread after its first page arrives, and stops once it scrolls', async () => {
		const { props, viewport } = await renderTranscript([]);
		expect(props.onLoadOlder).not.toHaveBeenCalled();
		props.messages = [message(3)];
		props.nextBefore = 3;
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		props.messages = [1, 2, 3].map(message);
		props.nextBefore = 1;
		await settle();
		resize();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		expect(viewport.scrollTop).toBe(300);
	});

	it('does not drop an upward scroll just after a resize notification', async () => {
		const { props, viewport, scrollTo } = await renderTranscript([1, 2, 3, 4, 5].map(message));
		resize();
		scrollTo(500);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		props.messages = [...props.messages, message(6)];
		await settle();
		resize();
		expect(viewport.scrollTop).toBe(500);
	});

	it('follows new output only at the bottom, and resumes after scrolling back down', async () => {
		const { props, viewport, scrollTo } = await renderTranscript([1, 2, 3, 4].map(message));
		props.messages = [...props.messages, message(5)];
		await settle();
		expect(viewport.scrollTop).toBe(900);
		scrollTo(500);
		props.messages = [...props.messages, message(6)];
		await settle();
		expect(viewport.scrollTop).toBe(500);
		scrollTo(1200);
		props.messages = [...props.messages, message(7)];
		await settle();
		expect(viewport.scrollTop).toBe(1500);
	});

	it.each(['wheel', 'touch', 'ArrowUp', 'PageUp', 'Home', 'Shift+Space'])(
		'stops following on upward %s input before a scroll event, even without older pages',
		async (input) => {
			const { props, viewport, scrollTo } = await renderTranscript([1, 2, 3, 4, 5].map(message));
			props.nextBefore = undefined;
			await settle();
			if (input === 'wheel') {
				viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }));
			} else if (input === 'touch') {
				for (const [type, clientY] of [
					['touchstart', 100],
					['touchmove', 110]
				] as const) {
					const event = new Event(type, { bubbles: true });
					Object.defineProperty(event, 'touches', { value: [{ clientY }] });
					viewport.dispatchEvent(event);
				}
			} else {
				viewport.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: input === 'Shift+Space' ? ' ' : input,
						shiftKey: input === 'Shift+Space',
						bubbles: true
					})
				);
			}
			props.messages = [...props.messages, message(6)];
			await settle();
			resize();
			expect(viewport.scrollTop).toBe(900);
			expect(props.onLoadOlder).not.toHaveBeenCalled();
			scrollTo(1200);
			props.messages = [...props.messages, message(7)];
			await settle();
			expect(viewport.scrollTop).toBe(1500);
		}
	);

	it('does not pull a small upward scroll back into the bottom tolerance', async () => {
		const { props, viewport, scrollTo } = await renderTranscript([1, 2, 3, 4, 5].map(message));
		scrollTo(890);
		props.messages = [...props.messages, message(6)];
		await settle();
		resize();
		expect(viewport.scrollTop).toBe(890);
	});

	it('respects a scrollbar move before its scroll event reaches the component', async () => {
		const { props, viewport } = await renderTranscript([1, 2, 3, 4, 5].map(message));
		viewport.scrollTop = 700;
		resize();
		expect(viewport.scrollTop).toBe(700);
		props.messages = [...props.messages, message(6)];
		await settle();
		expect(viewport.scrollTop).toBe(700);
	});

	it('does not write the scroll position for a resize that leaves the bottom unchanged', async () => {
		const { viewport } = await renderTranscript([1, 2, 3, 4].map(message));
		const writeScrollTop = vi.spyOn(viewport, 'scrollTop', 'set');
		resize();
		resize();
		expect(writeScrollTop).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		'preserves bottom-following state %s when shrinking content clamps the scroll position',
		async (following) => {
			const { props, viewport, scrollTo } = await renderTranscript([1, 2, 3, 4, 5].map(message));
			if (!following) scrollTo(700);
			props.messages = props.messages.slice(0, 3);
			flushSync();
			viewport.dispatchEvent(new Event('scroll'));
			await settle();
			resize();
			expect(viewport.scrollTop).toBe(300);
			props.messages = [...props.messages, message(4)];
			await settle();
			expect(viewport.scrollTop).toBe(following ? 600 : 300);
		}
	);

	it('opens a newly mounted thread at the bottom rather than reusing the previous reading position', async () => {
		const first = await renderTranscript([1, 2, 3, 4].map(message));
		first.scrollTo(100);
		await cleanup?.();
		const second = await renderTranscript([]);
		second.props.messages = [11, 12, 13, 14, 15].map(message);
		await settle();
		expect(second.viewport.scrollTop).toBe(900);
		expect(second.viewport.textContent).not.toContain('Message 4');
	});

	it('starts loading a viewport ahead of the top, only while scrolling upward', async () => {
		const { props, viewport, scrollTo } = await renderTranscript([1, 2, 3, 4, 5].map(message));
		expect(props.onLoadOlder).not.toHaveBeenCalled();
		expect(viewport.scrollTop).toBe(900);
		scrollTo(601);
		expect(props.onLoadOlder).not.toHaveBeenCalled();
		scrollTo(600);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		scrollTo(650);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		props.loadingOlder = true;
		await settle();
		scrollTo(0);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
	});

	it('fills short history with at most two older pages, even when collapsed work adds no height', async () => {
		const { props, viewport } = await renderTranscript([message(3)]);
		expect(viewport.textContent).not.toContain('Load earlier messages');
		expect(viewport.scrollHeight).toBe(viewport.clientHeight);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		props.loadingOlder = true;
		await settle();
		expect(viewport.textContent).not.toContain('Loading earlier messages');
		props.nextBefore = 2;
		props.loadingOlder = false;
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
		props.nextBefore = 1;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
		viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
		expect(props.onLoadOlder).toHaveBeenCalledTimes(3);
	});

	it('allows retry by touch after a failed short-page load without a background retry loop', async () => {
		const { props, viewport } = await renderTranscript([message(3)]);
		const touch = (type: string, clientY: number) => {
			const event = new Event(type, { bubbles: true });
			Object.defineProperty(event, 'touches', { value: [{ clientY }] });
			viewport.dispatchEvent(event);
		};
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		props.loadingOlder = true;
		await settle();
		props.stale = true;
		props.loadingOlder = false;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		touch('touchstart', 100);
		touch('touchmove', 150);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
	});

	it('accepts upward gestures within the bottom-stick tolerance', async () => {
		const { props, viewport, scrollTo } = await renderTranscript([1, 2, 3].map(message), 880);
		props.loadingOlder = true;
		await settle();
		scrollTo(0);
		props.loadingOlder = false;
		await settle();
		viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
	});

	it('retries from the top of overflowing history without requiring another scroll event', async () => {
		const { props, viewport, scrollTo } = await renderTranscript([1, 2, 3, 4].map(message));
		scrollTo(0);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		props.loadingOlder = true;
		await settle();
		props.loadingOlder = false;
		props.stale = true;
		await settle();
		viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
	});

	it('preserves a text section when older parts are prepended inside the same response', async () => {
		const response: LiveTranscriptMessage = {
			...liveMessage(),
			parts: [3, 4, 5, 6].map((number) => ({
				type: 'text',
				id: `text-${number}`,
				text: `Part ${number}`
			}))
		};
		const { props, viewport, scrollTo } = await renderTranscript([response]);
		scrollTo(150);
		const anchor = viewport.querySelector<HTMLElement>(
			'[data-transcript-anchor="response:run:text::text-3"]'
		);
		if (!anchor) throw new Error('Missing visible response section');
		const offset = anchor.getBoundingClientRect().top;
		props.messages = [
			{
				...response,
				parts: [{ type: 'text', id: 'text-2', text: 'Older part' }, ...response.parts]
			}
		];
		await settle();
		expect(anchor.isConnected).toBe(true);
		expect(anchor.getBoundingClientRect().top).toBe(offset);
		expect(viewport.scrollTop).toBe(450);
	});

	it('preserves the visible message offset when an older page is prepended', async () => {
		const { props, viewport, scrollTo } = await renderTranscript([3, 4, 5, 6].map(message));
		scrollTo(150);
		const anchor = viewport.querySelector<HTMLElement>('[data-message-id="prompt:3"]');
		if (!anchor) throw new Error('Missing visible message');
		const offset = anchor.getBoundingClientRect().top;
		props.messages = [message(1), message(2), ...props.messages];
		await settle();
		viewport.dispatchEvent(new Event('scroll'));
		expect(viewport.scrollTop).toBe(750);
		expect(anchor.getBoundingClientRect().top).toBe(offset);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
	});

	it('keeps a work disclosure open when a page prepends parts into that section', async () => {
		const response: LiveTranscriptMessage = {
			...liveMessage(),
			parts: [
				{ type: 'reasoning', id: 'r3', text: 'Recent reasoning' },
				{ type: 'text', id: 't4', text: 'Answer' }
			]
		};
		const { props, viewport } = await renderTranscript([response]);
		const button = viewport.querySelector<HTMLButtonElement>('button[aria-expanded]');
		if (!button) throw new Error('Missing work disclosure');
		button.click();
		await settle();
		expect(button.getAttribute('aria-expanded')).toBe('true');
		props.messages = [
			{
				...response,
				parts: [{ type: 'reasoning', id: 'r2', text: 'Older reasoning' }, ...response.parts]
			}
		];
		await settle();
		expect(button.isConnected).toBe(true);
		expect(button.getAttribute('aria-expanded')).toBe('true');
	});

	it.each([false, true])(
		'keeps disclosure state on its own work when sections split: %s',
		async (split) => {
			const first = { type: 'reasoning' as const, id: 'r1', text: 'First work' };
			const second = { type: 'reasoning' as const, id: 'r2', text: 'Second work' };
			const response: LiveTranscriptMessage = {
				...liveMessage(),
				parts: split ? [first, second] : [first]
			};
			const { props, viewport } = await renderTranscript([response]);
			const original = viewport.querySelector<HTMLButtonElement>(
				'[data-transcript-anchor] > div > button'
			);
			if (!original) throw new Error('Missing original work disclosure');
			original.click();
			await settle();
			props.messages = [
				{ ...response, parts: [first, { type: 'text', id: 't1', text: 'Update' }, second] }
			];
			await settle();
			const buttons = viewport.querySelectorAll<HTMLButtonElement>(
				'[data-transcript-anchor] > div > button'
			);
			expect(buttons).toHaveLength(2);
			expect(buttons[0]).toBe(original);
			expect(buttons[0]?.getAttribute('aria-expanded')).toBe('true');
			expect(buttons[1]?.getAttribute('aria-expanded')).toBe('false');
		}
	);
});
