import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import BrowserLiveView, { type BrowserApi } from './browser-live-view';
import type { BrowserStatus } from '$lib/types/sprocket';

function createBrowserApi() {
	return {
		browserDashboardUrl: 'http://localhost:7731/api/browser/dashboard/',
		startBrowser: vi.fn<BrowserApi['startBrowser']>(async () => ({
			state: 'installing',
			error: null
		})),
		fetchBrowserStatus: vi.fn<BrowserApi['fetchBrowserStatus']>(async () => ({
			state: 'ready',
			error: null
		}))
	};
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

it('starts setup on mount, polls installing status, and embeds the ready dashboard', async () => {
	const api = createBrowserApi();
	api.fetchBrowserStatus.mockResolvedValueOnce({ state: 'installing', error: null });
	render(<BrowserLiveView browserApi={api} />);
	await act(async () => {});
	expect(api.startBrowser).toHaveBeenCalledOnce();
	expect(screen.getByRole('status').textContent).toBe('Setting up the browser…');

	await act(() => vi.advanceTimersByTimeAsync(1000));
	expect(screen.getByRole('status').textContent).toBe('Setting up the browser…');
	await act(() => vi.advanceTimersByTimeAsync(1000));
	expect(api.fetchBrowserStatus).toHaveBeenCalledTimes(2);
	expect(screen.getByRole('status').textContent).toBe('Browser ready');
	expect(screen.getByTitle('Agent browser dashboard').getAttribute('src')).toBe(
		api.browserDashboardUrl
	);
	const external = screen.getByRole('link', { name: 'Open browser dashboard in a new tab' });
	expect(external.getAttribute('href')).toBe(api.browserDashboardUrl);
	expect(external.getAttribute('target')).toBe('_blank');

	await act(() => vi.advanceTimersByTimeAsync(10_000));
	expect(api.fetchBrowserStatus).toHaveBeenCalledTimes(4);
});

it.each<BrowserStatus['state']>(['error', 'installing', 'ready'])(
	'reports a dashboard error after starting in %s and retries through setup',
	async (state) => {
		const api = createBrowserApi();
		const error = 'Browser setup failed.';

		api.startBrowser.mockResolvedValueOnce({ state, error: state === 'error' ? error : null });

		if (state !== 'error') {
			api.fetchBrowserStatus.mockResolvedValueOnce({ state: 'error', error });
		}

		render(<BrowserLiveView browserApi={api} />);
		await act(async () => {});

		if (state !== 'error') {
			await act(() => vi.advanceTimersByTimeAsync(state === 'installing' ? 1000 : 5000));
		}

		expect(screen.getByRole('alert').textContent).toBe(error);
		fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
		await act(async () => {});
		expect(api.startBrowser).toHaveBeenCalledTimes(2);
		expect(screen.getByRole('status').textContent).toBe('Setting up the browser…');
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(screen.getByTitle('Agent browser dashboard')).toBeTruthy();
	}
);

it.each(['startBrowser', 'fetchBrowserStatus'] as const)(
	'exposes %s request failures with a retry action',
	async (method) => {
		const api = createBrowserApi();
		api[method].mockRejectedValueOnce(new Error('The Sprocket server disconnected.'));
		render(<BrowserLiveView browserApi={api} />);
		await act(async () => {});
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(screen.getByRole('alert').textContent).toBe('The Sprocket server disconnected.');
		expect(screen.getByRole('button', { name: 'Retry setup' })).toBeTruthy();
	}
);

it('waits for each poll to finish and cancels in-flight work on unmount', async () => {
	const api = createBrowserApi();
	const pending = Promise.withResolvers<BrowserStatus>();
	api.fetchBrowserStatus.mockReturnValueOnce(pending.promise);
	const view = render(<BrowserLiveView browserApi={api} />);
	await act(async () => {});
	await act(() => vi.advanceTimersByTimeAsync(5000));
	expect(api.fetchBrowserStatus).toHaveBeenCalledOnce();
	const signal = api.fetchBrowserStatus.mock.calls[0][0];
	expect(signal?.aborted).toBe(false);
	view.unmount();
	expect(signal?.aborted).toBe(true);
	await act(async () => pending.resolve({ state: 'installing', error: null }));
	expect(vi.getTimerCount()).toBe(0);
});

it('explains the local server requirement without a connected API', () => {
	render(<BrowserLiveView browserApi={null} />);
	expect(screen.getByRole('status').textContent).toBe(
		'Connect to the local Sprocket server to use the browser.'
	);
});
