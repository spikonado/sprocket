import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import type { Id } from '$convex/_generated/dataModel';
import type { ThreadMessage } from '$lib/types/sprocket';
import ThreadTranscript from './thread-transcript.svelte';

let cleanup: (() => Promise<void>) | undefined;

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
	await vi.runOnlyPendingTimersAsync();
}

async function renderTranscript(numbers: number[]) {
	const props = $state<ComponentProps<typeof ThreadTranscript>>({
		currentError: null,
		runError: null,
		messages: numbers.map(message),
		actions: [],
		activeRunId: null,
		project: null,
		hasOlder: true,
		onLoadOlder: vi.fn()
	});
	const component = mount(ThreadTranscript, { target: document.body, props });
	cleanup = () => unmount(component);
	const viewport = document.querySelector<HTMLDivElement>('.overflow-auto');
	if (!viewport) throw new Error('Missing transcript viewport');
	const messageElements = () => [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')];
	let scrollTop = 0;
	// jsdom has no layout. Model fixed-height rows while exercising the real DOM and effects.
	Object.defineProperties(viewport, {
		clientHeight: { get: () => 600 },
		scrollHeight: { get: () => Math.max(600, messageElements().length * 300) },
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
		return new DOMRect(0, index < 0 ? 0 : index * 300 - scrollTop, 800, index < 0 ? 600 : 300);
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

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('transcript viewport paging', () => {
	it('loads only near the top, not at the bottom or while an older page is loading', async () => {
		const { props, viewport, scrollTo } = await renderTranscript([1, 2, 3]);
		expect(props.onLoadOlder).not.toHaveBeenCalled();
		scrollTo(300);
		expect(viewport.scrollTop).toBe(300);
		scrollTo(201);
		expect(props.onLoadOlder).not.toHaveBeenCalled();
		scrollTo(200);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		props.loadingOlder = true;
		await settle();
		scrollTo(0);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
	});

	it('fills a short viewport silently without loading beyond it or retrying on loading-state changes', async () => {
		const { props, viewport } = await renderTranscript([3]);
		expect(viewport.textContent).not.toContain('Load earlier messages');
		expect(viewport.scrollHeight).toBe(viewport.clientHeight);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		props.loadingOlder = true;
		await settle();
		expect(viewport.textContent).not.toContain('Loading earlier messages');
		props.loadingOlder = false;
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
		props.messages = [message(2), ...props.messages];
		await settle();
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
		props.messages = [message(1), ...props.messages];
		await settle();
		expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(2);
	});

	it('preserves the visible message offset when an older page is prepended', async () => {
		const { props, viewport, scrollTo } = await renderTranscript([3, 4, 5, 6]);
		scrollTo(150);
		const anchor = viewport.querySelector<HTMLElement>('[data-message-id="prompt:3"]');
		if (!anchor) throw new Error('Missing visible message');
		const offset = anchor.getBoundingClientRect().top;
		props.messages = [message(1), message(2), ...props.messages];
		await settle();
		expect(viewport.scrollTop).toBe(750);
		expect(anchor.getBoundingClientRect().top).toBe(offset);
		expect(props.onLoadOlder).toHaveBeenCalledTimes(1);
	});
});
