import { afterEach, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Id } from '$convex/_generated/dataModel';
import BrowserLiveView from './browser-live-view.svelte';

let cleanup: () => Promise<void>;
afterEach(async () => {
	await cleanup();
	document.body.replaceChildren();
});

it.each([true, false])(
	'hides the saving indicator for saving=%s without hiding controls',
	(saving) => {
		const component = mount(BrowserLiveView, {
			target: document.body,
			props: {
				active: true,
				liveView: {
					url: null,
					interactiveUrl: 'https://example.com/interactive',
					saving,
					humanControl: false,
					expiresAt: Date.now() + 60_000,
					// SAFETY: This ID is only used by the mounted test component.
					threadId: 'thread' as Id<'threadRecords'>,
					lastUsedRunId: null,
					startedAt: Date.now()
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
