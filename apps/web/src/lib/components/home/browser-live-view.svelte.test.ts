import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { closeConvex } from 'convex-svelte';
import { initConvex } from 'convex-svelte/sveltekit';
import { getFunctionName } from 'convex/server';
import type { Id } from '$convex/_generated/dataModel';
import type { BrowserLiveViewState } from '$lib/chat/side-panel';
import BrowserLiveView from './browser-live-view.svelte';

let cleanup: () => Promise<void>;
afterEach(async () => {
	await cleanup();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	await closeConvex();
});

it.each(['provider-session', null])(
	'stops the displayed provider session %s, prevents duplicate requests, and shows an ended view',
	async (providerSessionId) => {
		const client = initConvex('https://example.convex.cloud', { disabled: true });
		const result = Promise.withResolvers<null>();
		const mutation = vi.spyOn(client, 'mutation').mockReturnValue(result.promise);
		const props = $state({
			active: true,
			liveView: { ...session(Date.now() + 60_000), providerSessionId }
		});
		if (providerSessionId === null) {
			props.liveView.url = null;
			props.liveView.interactiveUrl = null;
		}
		const component = mount(BrowserLiveView, { target: document.body, props });
		cleanup = () => unmount(component);
		flushSync();
		const button = document.querySelector<HTMLButtonElement>(
			'button[aria-label="Stop browser session"]'
		);
		expect(button).not.toBeNull();
		button!.click();
		flushSync();
		expect(button!.disabled).toBe(true);
		expect(button!.getAttribute('aria-busy')).toBe('true');
		button!.click();
		expect(mutation).toHaveBeenCalledTimes(1);
		expect(getFunctionName(mutation.mock.calls[0][0])).toBe('browserSessions:stop');
		expect(mutation.mock.calls[0][1]).toEqual({ id: props.liveView.id, providerSessionId });
		result.resolve(null);
		await tick();
		props.liveView.ended = true;
		flushSync();
		expect(document.querySelector('iframe, button')).toBeNull();
		expect(document.body.textContent).toContain('Browser session ended.');
	}
);

it('keeps the session visible and allows retry when stopping fails', async () => {
	const client = initConvex('https://example.convex.cloud', { disabled: true });
	vi.spyOn(client, 'mutation').mockRejectedValue(new Error('Connection lost'));
	const component = mount(BrowserLiveView, {
		target: document.body,
		props: { active: false, liveView: session(Date.now() + 60_000) }
	});
	cleanup = () => unmount(component);
	flushSync();
	const button = document.querySelector<HTMLButtonElement>(
		'button[aria-label="Stop browser session"]'
	);
	button!.click();
	await tick();
	flushSync();
	expect(document.querySelector('[role="alert"]')?.textContent).toContain('Connection lost');
	expect(button!.disabled).toBe(false);
	expect(document.querySelector('iframe')).not.toBeNull();
});

function session(expiresAt: number, ended = false): BrowserLiveViewState {
	return {
		// SAFETY: This ID is only used by the mounted test component.
		id: 'session' as Id<'browserSessions'>,
		providerSessionId: 'provider-session',
		url: 'https://example.com/passive',
		interactiveUrl: 'https://example.com/interactive',
		saving: true,
		humanControl: true,
		expiresAt,
		ended,
		// SAFETY: This ID is only used by the mounted test component.
		threadId: 'thread' as Id<'threadRecords'>,
		lastUsedRunId: null,
		startedAt: expiresAt - 3_600_000
	};
}

it.each([true, false])(
	'does not show stop errors from the previous provider session, rejectedBeforeReplacement=%s',
	async (rejectedBeforeReplacement) => {
		const client = initConvex('https://example.convex.cloud', { disabled: true });
		const result = Promise.withResolvers<null>();
		vi.spyOn(client, 'mutation').mockReturnValue(result.promise);
		const props = $state({ active: true, liveView: session(Date.now() + 60_000) });
		const component = mount(BrowserLiveView, { target: document.body, props });
		cleanup = () => unmount(component);
		flushSync();
		document.querySelector<HTMLButtonElement>('button[aria-label="Stop browser session"]')!.click();
		if (rejectedBeforeReplacement) {
			result.reject(new Error('Connection lost'));
			await tick();
			flushSync();
			expect(document.querySelector('[role="alert"]')?.textContent).toContain('Connection lost');
		}
		props.liveView.providerSessionId = 'replacement-session';
		flushSync();
		if (!rejectedBeforeReplacement) {
			result.reject(new Error('Connection lost'));
			await tick();
			flushSync();
		}
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(
			document.querySelector<HTMLButtonElement>('button[aria-label="Stop browser session"]')!
				.disabled
		).toBe(false);
		expect(document.querySelector('iframe')).not.toBeNull();
	}
);

it.each([true, false])(
	'does not load an ended session when reopening the panel, with URLs=%s',
	(hasUrls) => {
		const liveView = session(Date.now() + 60_000, true);
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

it('unmounts an ended live view and shows a later session without reopening the panel', () => {
	const props = $state({ active: true, liveView: session(Date.now() + 1_000) });
	const component = mount(BrowserLiveView, { target: document.body, props });
	cleanup = () => unmount(component);
	flushSync();
	expect(document.querySelector('iframe')).not.toBeNull();
	props.liveView.ended = true;
	flushSync();
	expect(document.querySelector('iframe, button, a, .animate-spin')).toBeNull();
	expect(document.body.textContent).toContain('Browser session ended.');
	props.liveView = session(Date.now() + 3_600_000);
	flushSync();
	expect(document.querySelector('iframe')).not.toBeNull();
	expect(document.body.textContent).not.toContain('Browser session ended.');
});

it.each([-3_600_000, 3_600_000])(
	'uses backend status when the client clock is skewed by %s milliseconds',
	(skew) => {
		vi.useFakeTimers();
		const serverNow = Date.now();
		const props = $state({ active: true, liveView: session(serverNow + 60_000) });
		vi.setSystemTime(serverNow + skew);
		const component = mount(BrowserLiveView, { target: document.body, props });
		cleanup = () => unmount(component);
		flushSync();
		expect(document.querySelector('iframe')).not.toBeNull();
		expect(document.querySelector('button')?.disabled).toBe(false);
		expect(document.querySelector('a')).not.toBeNull();
		expect(document.body.textContent).not.toMatch(/Expired|Browser session ended/);
		props.liveView.ended = true;
		flushSync();
		expect(document.querySelector('iframe, button, a, .animate-spin')).toBeNull();
		expect(document.body.textContent).toContain('Browser session ended.');
	}
);

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
