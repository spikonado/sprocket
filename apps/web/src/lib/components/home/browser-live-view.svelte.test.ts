import { afterEach, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { BrowserLiveViewState } from '$lib/chat/side-panel';
import BrowserLiveView from './browser-live-view.svelte';

let cleanup: () => Promise<void>;
afterEach(async () => {
	await cleanup();
	document.body.replaceChildren();
});

function session(expiresAt: number, ended = false): BrowserLiveViewState {
	return {
		id: 'session',
		providerSessionId: 'provider-session',
		url: 'https://example.com/passive',
		interactiveUrl: 'https://example.com/interactive',
		saving: true,
		humanControl: true,
		expiresAt,
		ended,
		threadId: 'thread',
		lastUsedRunId: null,
		startedAt: expiresAt - 3_600_000
	};
}

it('renders the iframe for an active session', () => {
	const component = mount(BrowserLiveView, {
		target: document.body,
		props: { active: true, liveView: session(Date.now() + 60_000) }
	});
	cleanup = () => unmount(component);
	flushSync();
	expect(document.querySelector('iframe')).not.toBeNull();
});

it('reports that browser actions are unavailable until a backend exists', async () => {
	const component = mount(BrowserLiveView, {
		target: document.body,
		props: { active: true, liveView: session(Date.now() + 60_000) }
	});
	cleanup = () => unmount(component);
	flushSync();
	document.querySelector<HTMLButtonElement>('button[aria-label="Stop browser session"]')!.click();
	flushSync();
	await Promise.resolve();
	flushSync();
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		'Browser sessions are not available yet.'
	);
});

it('shows the ended state and hides controls for an ended session', () => {
	const component = mount(BrowserLiveView, {
		target: document.body,
		props: { active: false, liveView: session(Date.now() + 60_000, true) }
	});
	cleanup = () => unmount(component);
	flushSync();
	expect(document.querySelector('iframe, button, a')).toBeNull();
	expect(document.body.textContent).toContain('Browser session ended.');
});

it('shows the empty state when there is no session', () => {
	const component = mount(BrowserLiveView, {
		target: document.body,
		props: { active: false, liveView: null }
	});
	cleanup = () => unmount(component);
	flushSync();
	expect(document.body.textContent).toContain('No active browser session.');
});
