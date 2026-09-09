import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Id } from '$convex/_generated/dataModel';
import type { BrowserLiveViewState } from '$lib/chat/side-panel';
import BrowserLiveView from './browser-live-view.svelte';

let cleanup: () => Promise<void>;
afterEach(async () => {
	await cleanup();
	document.body.replaceChildren();
	vi.useRealTimers();
});

function session(expiresAt: number): BrowserLiveViewState {
	return {
		url: 'https://example.com/passive',
		interactiveUrl: 'https://example.com/interactive',
		saving: true,
		humanControl: true,
		expiresAt,
		// SAFETY: This ID is only used by the mounted test component.
		threadId: 'thread' as Id<'threadRecords'>,
		lastUsedRunId: null,
		startedAt: expiresAt - 3_600_000
	};
}

it.each([true, false])(
	'does not load an expired session when reopening the panel, with URLs=%s',
	(hasUrls) => {
		const liveView = session(Date.now() - 1);
		if (!hasUrls) {
			liveView.url = null;
			liveView.interactiveUrl = null;
		}
		const component = mount(BrowserLiveView, {
			target: document.body,
			props: { active: false, liveView }
		});
		cleanup = () => unmount(component);
		flushSync();
		expect(document.querySelector('iframe, button, a, .animate-spin')).toBeNull();
		expect(document.body.textContent).toContain('Browser session ended.');
	}
);

it('unmounts the live view at expiry and shows a later session without reopening the panel', async () => {
	vi.useFakeTimers();
	const props = $state({ active: true, liveView: session(Date.now() + 1_000) });
	const component = mount(BrowserLiveView, { target: document.body, props });
	cleanup = () => unmount(component);
	flushSync();
	expect(document.querySelector('iframe')).not.toBeNull();
	await vi.advanceTimersByTimeAsync(1_000);
	flushSync();
	expect(document.querySelector('iframe, button, a, .animate-spin')).toBeNull();
	expect(document.body.textContent).toContain('Browser session ended.');
	props.liveView = session(Date.now() + 3_600_000);
	flushSync();
	expect(document.querySelector('iframe')).not.toBeNull();
	expect(document.body.textContent).not.toContain('Browser session ended.');
});

it('removes the iframe when provider timeout cleanup clears the session', () => {
	const props = $state<{ active: boolean; liveView: BrowserLiveViewState | null }>({
		active: false,
		liveView: session(Date.now() + 3_600_000)
	});
	const component = mount(BrowserLiveView, { target: document.body, props });
	cleanup = () => unmount(component);
	flushSync();
	expect(document.querySelector('iframe')).not.toBeNull();
	props.liveView = null;
	flushSync();
	expect(document.querySelector('iframe, button, a, .animate-spin')).toBeNull();
	expect(document.body.textContent).toContain('No active browser session.');
});

it.each([true, false])(
	'hides the saving indicator for saving=%s without hiding controls',
	(saving) => {
		const component = mount(BrowserLiveView, {
			target: document.body,
			props: {
				active: true,
				liveView: {
					...session(Date.now() + 60_000),
					url: null,
					saving,
					humanControl: false
				}
			}
		});
		cleanup = () => unmount(component);
		flushSync();
		expect(document.body.textContent).not.toMatch(/saving/i);
		expect(document.body.textContent).toContain('Closes by');
		expect(document.querySelector('button')?.textContent?.trim()).toBe('Take control');
	}
);
