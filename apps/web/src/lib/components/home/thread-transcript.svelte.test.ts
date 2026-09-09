import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import type { Id } from '$convex/_generated/dataModel';
import type { ThreadMessage } from '$lib/types/sprocket';
import ThreadTranscript from './thread-transcript.svelte';

let cleanup: (() => Promise<void>) | undefined;
let resize: () => void;

function message(number: number): ThreadMessage {
	return {
		_id: `prompt:${number}`,
		// SAFETY: Fixture IDs never leave the mounted component.
		threadId: 'thread' as Id<'threadRecords'>,
		// SAFETY: Fixture IDs never leave the mounted component.
		runId: `run-${number}` as Id<'runs'>,
		userId: 'user',
		type: 'prompt',
		text: `Message ${number}`,
		parts: [],
		attachments: [],
		runStatus: 'completed',
		runStartedAt: 1,
		sourceNumbers: [number]
	};
}

async function settle() {
	flushSync();
	await tick();
	await vi.advanceTimersByTimeAsync(16);
}

async function renderTranscript(messages: ThreadMessage[], viewportHeight = 600) {
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
	const viewport = document.querySelector<HTMLDivElement>('.overflow-auto');
	if (!viewport) throw new Error('Missing transcript viewport');
	const messageElements = () => [
		...viewport.querySelectorAll<HTMLElement>('[data-transcript-anchor]')
	];
	let scrollTop = 0;
	// jsdom has no layout. Model fixed-height rows while exercising the real DOM and effects.
	Object.defineProperties(viewport, {
		clientHeight: { get: () => viewportHeight },
		scrollHeight: { get: () => Math.max(viewportHeight, messageElements().length * 300) },
		scrollTop: {
			get: () => scrollTop,
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
			index < 0 ? 0 : index * 300 - scrollTop,
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
		const response: ThreadMessage = {
			...message(3),
			_id: 'response:run',
			type: 'response',
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
		const response: ThreadMessage = {
			...message(3),
			_id: 'response:run',
			type: 'response',
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
			const response: ThreadMessage = {
				...message(3),
				_id: 'response:run',
				type: 'response',
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
