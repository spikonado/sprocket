import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { UpdateState } from '$lib/updates';
import AppUpdate from './app-update';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	delete window.sprocketDesktopBridge;
});

const available: UpdateState = {
	method: 'package',
	status: 'available',
	currentVersion: '1.0.0',
	version: '1.1.0',
	error: null
};

function mount(automaticAgentContinuation?: boolean, loading = false) {
	const client = new ConvexTestClient();

	if (!loading) {
		const preferences: Doc<'uiPreferences'> | null =
			automaticAgentContinuation === undefined
				? null
				: {
						// SAFETY: this fixture id is only used by the in-memory Convex client.
						_id: 'preferences-test' as Id<'uiPreferences'>,
						_creationTime: 1,
						userId: 'user-test',
						theme: 'light',
						automaticAgentContinuation
					};

		client.registerQuery(api.uiPreferences.getMine, preferences);
	}

	const view = render(
		<ConvexTestProvider client={client}>
			<AppUpdate />
		</ConvexTestProvider>
	);

	return { client, view };
}

it('installs a package update on the first click and prevents another request while busy', async () => {
	const installation = Promise.withResolvers<Response>();

	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json(available))
		.mockReturnValueOnce(installation.promise);

	vi.stubGlobal('fetch', fetcher);
	mount();

	const button = await screen.findByRole('button', { name: 'Update available' });

	fireEvent.click(button);
	expect(fetcher).toHaveBeenNthCalledWith(
		2,
		expect.stringContaining('/api/update/install'),
		expect.objectContaining({ method: 'POST' })
	);
	expect(button.hasAttribute('disabled')).toBe(true);
	fireEvent.click(button);
	expect(fetcher).toHaveBeenCalledTimes(2);

	await act(async () => installation.resolve(Response.json({ ...available, status: 'installed' })));
	expect(screen.getByRole('button', { name: 'Restart Sprocket' })).toHaveProperty(
		'disabled',
		false
	);
	expect(screen.queryByText(/stop Sprocket in your terminal/)).toBeNull();
});

it.each([undefined, true])(
	'restarts without confirmation when automatic continuation is %s',
	async (enabled) => {
		const restarted = Promise.withResolvers<Response>();

		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ ...available, status: 'installed' }))
			.mockReturnValueOnce(restarted.promise);

		vi.stubGlobal('fetch', fetcher);
		mount(enabled);
		const button = await screen.findByRole('button', { name: 'Restart Sprocket' });
		await act(async () => fireEvent.click(button));
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(fetcher).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('/api/update/restart'),
			expect.objectContaining({ method: 'POST' })
		);
		expect(button).toHaveProperty('disabled', true);
		expect(button.textContent).toBe('Restarting Sprocket...');
		fireEvent.click(button);
		expect(fetcher).toHaveBeenCalledTimes(2);
		await act(async () => restarted.reject(new Error('Restart failed')));
		expect(screen.getByRole('alert').textContent).toBe('Restart failed');
	}
);

it('drops an install error once a later check shows the update installed', async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });

	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json(available))
		.mockRejectedValueOnce(new Error('Connection lost'))
		.mockResolvedValueOnce(Response.json({ ...available, status: 'installed' }));

	vi.stubGlobal('fetch', fetcher);
	mount();
	fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
	expect(await screen.findByText('Connection lost')).toBeTruthy();

	await act(() => vi.advanceTimersByTimeAsync(5_000));
	expect(screen.getByRole('button', { name: 'Restart Sprocket' })).toBeTruthy();
	expect(screen.queryByText('Connection lost')).toBeNull();
});

it('confirms restart when automatic continuation is off and lets the user cancel', async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ ...available, status: 'installed' }))
		.mockRejectedValueOnce(new Error('Restart failed'));

	vi.stubGlobal('fetch', fetcher);
	mount(false);
	const button = await screen.findByRole('button', { name: 'Restart Sprocket' });
	await act(async () => fireEvent.click(button));
	const dialog = screen.getByRole('dialog', { name: 'Restart Sprocket?' });
	expect(dialog.textContent).toContain("they won't resume automatically");
	expect(fetcher).toHaveBeenCalledTimes(1);
	fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
	expect(screen.queryByRole('dialog')).toBeNull();
	expect(fetcher).toHaveBeenCalledTimes(1);
	await act(async () => fireEvent.click(button));
	await act(async () =>
		fireEvent.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Restart Sprocket' })
		)
	);
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it('waits for the restart preference to load', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue(Response.json({ ...available, status: 'installed' }))
	);
	const { client } = mount(undefined, true);
	const button = await screen.findByRole('button', { name: 'Restart Sprocket' });
	expect(button).toHaveProperty('disabled', true);
	await act(async () => client.registerQuery(api.uiPreferences.getMine, null));
	expect(button).toHaveProperty('disabled', false);
});

it('always confirms a desktop restart because it interrupts agents', async () => {
	const install = vi
		.fn()
		.mockResolvedValue({ ...available, method: 'desktop', status: 'installing' });

	window.sprocketDesktopBridge = {
		takeWorkspaceLaunch: async () => null,
		onWorkspaceLaunch: () => () => {},
		openExternal: async () => {},
		focusWindow: async () => true,
		updates: {
			getState: async () => ({ ...available, method: 'desktop', status: 'downloaded' }),
			download: vi.fn(),
			install,
			onState: () => () => {}
		}
	};
	mount(true);
	const button = await screen.findByRole('button', { name: 'Restart to update' });
	await act(async () => fireEvent.click(button));
	expect(install).not.toHaveBeenCalled();

	expect(screen.getByRole('dialog').textContent).toContain(
		"interrupts active agents. They won't resume automatically."
	);

	await act(async () =>
		fireEvent.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Restart Sprocket' })
		)
	);
	expect(install).toHaveBeenCalledTimes(1);
});

it('continues the accepted restart after the sidebar unmounts', async () => {
	const accepted = Promise.withResolvers<Response>();

	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ ...available, status: 'installed' }))
		.mockReturnValueOnce(accepted.promise)
		.mockRejectedValueOnce(new Error('offline'));

	vi.stubGlobal('fetch', fetcher);
	const { view } = mount();
	const button = await screen.findByRole('button', { name: 'Restart Sprocket' });
	await act(async () => fireEvent.click(button));
	view.unmount();
	vi.useFakeTimers();
	await act(async () => accepted.resolve(Response.json({ instanceId: 'old' })));
	expect(fetcher).toHaveBeenNthCalledWith(
		3,
		expect.stringContaining('/api/health'),
		expect.objectContaining({ signal: expect.any(AbortSignal) })
	);
	expect(fetcher.mock.calls[2]![1]).toEqual(
		expect.objectContaining({ signal: expect.objectContaining({ aborted: false }) })
	);
	await act(async () => vi.advanceTimersByTimeAsync(90_000));
	vi.useRealTimers();
});
