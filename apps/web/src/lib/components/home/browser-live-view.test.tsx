import { expect, it } from 'vitest';
import { act } from 'react';
import { render } from '@testing-library/react';
import type { BrowserLiveViewState } from '$lib/chat/side-panel';
import BrowserLiveView from './browser-live-view';

function session(expiresAt: number, ended = false, id = 'session'): BrowserLiveViewState {
	return {
		id,
		providerSessionId: `provider-${id}`,
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

function renderLiveView(props: {
	liveView: BrowserLiveViewState | null | undefined;
	active: boolean;
}) {
	return render(<BrowserLiveView {...props} />);
}

it('renders the iframe for an active session', () => {
	renderLiveView({ active: true, liveView: session(Date.now() + 60_000) });
	expect(document.querySelector('iframe')).not.toBeNull();
});

it('reports that browser actions are unavailable until a backend exists', async () => {
	renderLiveView({ active: true, liveView: session(Date.now() + 60_000) });
	await act(async () => {
		document.querySelector<HTMLButtonElement>('button[aria-label="Stop browser session"]')!.click();
	});
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		'Browser sessions are not available yet.'
	);
});

it('shows the ended state and hides controls for an ended session', () => {
	renderLiveView({ active: false, liveView: session(Date.now() + 60_000, true) });
	expect(document.querySelector('iframe, button, a')).toBeNull();
	expect(document.body.textContent).toContain('Browser session ended.');
});

it('shows the empty state when there is no session', () => {
	renderLiveView({ active: false, liveView: null });
	expect(document.body.textContent).toContain('No active browser session.');
});

it('does not surface an action failure after the session rotates', async () => {
	const { rerender } = renderLiveView({ active: true, liveView: session(Date.now() + 60_000) });
	await act(async () => {
		document.querySelector<HTMLButtonElement>('button[aria-label="Stop browser session"]')!.click();
		rerender(
			<BrowserLiveView active liveView={session(Date.now() + 60_000, false, 'rotated-session')} />
		);
	});
	// The stop request rejects only after the rotation has already rendered.
	await act(async () => {
		await Promise.resolve();
	});
	expect(document.querySelector('[role="alert"]')).toBeNull();
});
