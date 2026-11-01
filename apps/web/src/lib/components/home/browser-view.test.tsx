import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import BrowserView, { type BrowserApi } from './browser-view';
import type { BrowserStatus } from '$lib/types/sprocket';

type WatchHandlers = Parameters<BrowserApi['watchBrowserStatus']>[0];

function createBrowserApi() {
	const watches: { handlers: WatchHandlers; fail: (error: Error) => void }[] = [];

	const api = {
		browserDashboardUrl: 'http://localhost:7731/api/browser/dashboard/',
		startBrowser: vi.fn<BrowserApi['startBrowser']>(async () => ({
			state: 'installing',
			error: null
		})),
		watchBrowserStatus: vi.fn<BrowserApi['watchBrowserStatus']>(
			(handlers) =>
				new Promise<void>((resolve, reject) => {
					handlers.signal.addEventListener('abort', () => resolve());
					watches.push({ handlers, fail: reject });
				})
		)
	};

	async function push(status: BrowserStatus) {
		await act(async () => watches.at(-1)?.handlers.onEvent(status));
	}

	return { api, watches, push };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

it('starts setup, then follows pushed status into the ready dashboard', async () => {
	const { api, push } = createBrowserApi();
	render(<BrowserView browserApi={api} />);
	await act(async () => {});
	expect(api.startBrowser).toHaveBeenCalledOnce();
	expect(api.watchBrowserStatus).toHaveBeenCalledOnce();
	expect(screen.getByRole('status').textContent).toBe('Setting up the browser…');

	await push({ state: 'ready', error: null });
	expect(screen.getByRole('status').textContent).toBe('Browser ready');
	expect(screen.getByTitle('Agent browser dashboard').getAttribute('src')).toBe(
		api.browserDashboardUrl
	);
	const external = screen.getByRole('link', { name: 'Open browser dashboard in a new tab' });
	expect(external.getAttribute('href')).toBe(api.browserDashboardUrl);
	expect(external.getAttribute('target')).toBe('_blank');
});

it('reports a pushed dashboard error and retries through setup', async () => {
	const { api, push } = createBrowserApi();
	render(<BrowserView browserApi={api} />);
	await act(async () => {});
	await push({ state: 'error', error: 'The browser dashboard stopped.' });
	expect(screen.getByRole('alert').textContent).toBe('The browser dashboard stopped.');

	fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
	await act(async () => {});
	expect(api.startBrowser).toHaveBeenCalledTimes(2);
	expect(screen.getByRole('status').textContent).toBe('Setting up the browser…');
	await push({ state: 'ready', error: null });
	expect(screen.getByTitle('Agent browser dashboard')).toBeTruthy();
});

it.each<[string, () => Promise<BrowserStatus>]>([
	['rejects', async () => Promise.reject(new Error('The Sprocket server disconnected.'))],
	['fails', async () => ({ state: 'error', error: 'The Sprocket server disconnected.' })]
])('shows a retry action when starting %s', async (_, start) => {
	const { api } = createBrowserApi();
	api.startBrowser.mockImplementationOnce(start);
	render(<BrowserView browserApi={api} />);
	await act(async () => {});
	expect(api.watchBrowserStatus).not.toHaveBeenCalled();
	expect(screen.getByRole('alert').textContent).toBe('The Sprocket server disconnected.');
	expect(screen.getByRole('button', { name: 'Retry setup' })).toBeTruthy();
});

it('restarts and resubscribes after the subscription drops, and stops on unmount', async () => {
	const { api, watches } = createBrowserApi();
	const view = render(<BrowserView browserApi={api} />);
	await act(async () => {});
	await act(async () => watches[0].fail(new Error('Lost the live connection.')));
	expect(api.watchBrowserStatus).toHaveBeenCalledOnce();

	await act(() => vi.advanceTimersByTimeAsync(1000));
	expect(api.startBrowser).toHaveBeenCalledTimes(2);
	expect(api.watchBrowserStatus).toHaveBeenCalledTimes(2);

	view.unmount();
	expect(watches[1].handlers.signal.aborted).toBe(true);
	await act(async () => {});
	expect(vi.getTimerCount()).toBe(0);
});

it('explains the local server requirement without a connected API', () => {
	render(<BrowserView browserApi={null} />);
	expect(screen.getByRole('status').textContent).toBe(
		'Connect to the local Sprocket server to use the browser.'
	);
});
