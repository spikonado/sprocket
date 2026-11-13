import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { VercelStatus } from '$lib/types/sprocket';
import VercelConnector, { type VercelApi } from './vercel-connector';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function vercel(account: VercelStatus['account']): VercelStatus {
	return { install: { state: 'installed' }, version: '50.1.0', account };
}

function mount(status: VercelStatus, overrides: Partial<VercelApi> = {}) {
	const api = {
		fetchVercelStatus: vi.fn<VercelApi['fetchVercelStatus']>(async () => status),
		signOutVercel: vi.fn<VercelApi['signOutVercel']>(async () => vercel({ state: 'signedOut' })),
		installConnectorCli: vi.fn<VercelApi['installConnectorCli']>(),
		fetchConnectorSignIn: vi.fn<VercelApi['fetchConnectorSignIn']>(async () => ({ state: 'idle' })),
		startConnectorSignIn: vi.fn<VercelApi['startConnectorSignIn']>(),
		cancelConnectorSignIn: vi.fn<VercelApi['cancelConnectorSignIn']>(),
		...overrides
	};

	render(<VercelConnector userId="user-a" localApi={api} />);

	return api;
}

it('shows the sign-in failure once the device flow fails', async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });

	mount(vercel({ state: 'signedOut' }), {
		startConnectorSignIn: async () => ({
			state: 'waiting',
			url: 'https://vercel.com/oauth/device?user_code=WXYZ',
			code: null
		}),
		fetchConnectorSignIn: async () => ({ state: 'failed', error: 'The sign-in timed out.' })
	});

	fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
	expect(await screen.findByText('Finish signing in on vercel.com')).toBeTruthy();
	await act(() => vi.advanceTimersByTimeAsync(2000));
	expect((await screen.findByRole('alert')).textContent).toBe('The sign-in timed out.');
	expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
});

it('signs out of a Vercel CLI login', async () => {
	const api = mount(vercel({ state: 'signedIn', login: 'ada', source: 'cli' }));

	expect(await screen.findByText('Signed in as ada · Vercel CLI login')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

	expect(api.signOutVercel).toHaveBeenCalledWith('user-a');
	await waitFor(() => expect(screen.getByText('Not signed in')).toBeTruthy());
});
