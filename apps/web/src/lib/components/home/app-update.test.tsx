import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { ConvexTestClient, ConvexTestProvider, fixtureId } from '$lib/convex-test-client';
import { stubWebSocket } from '$lib/local/socket-test-support';
import type { ConnectorStatus } from '$lib/types/sprocket';
import type { UpdateState } from '$lib/updates';
import AppUpdate, { type ConnectorUpdatesApi } from './app-update';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
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

function preferences(automaticAgentContinuation?: boolean): Doc<'uiPreferences'> | null {
	return automaticAgentContinuation === undefined
		? null
		: {
				_id: fixtureId<'uiPreferences'>('preferences-test'),
				_creationTime: 1,
				userId: 'user-test',
				theme: 'light',
				automaticAgentContinuation
			};
}

function mount(
	automaticAgentContinuation?: boolean,
	loading = false,
	localApi: ConnectorUpdatesApi | null = null
) {
	const client = new ConvexTestClient();

	if (!loading) {
		client.registerQuery(api.uiPreferences.getMine, preferences(automaticAgentContinuation));
	}

	vi.stubEnv('VITE_LOCAL_API_URL', 'http://127.0.0.1:7300');
	const sockets = stubWebSocket();

	render(
		<ConvexTestProvider client={client}>
			<AppUpdate userId="user-test" localApi={localApi} />
		</ConvexTestProvider>
	);
	sockets[0]?.open();

	const publish = (state: UpdateState) =>
		act(() => {
			sockets[0]?.onmessage?.({ data: JSON.stringify({ type: 'event', id: 1, data: state }) });
		});

	const setContinuation = (enabled: boolean) =>
		act(() => client.registerQuery(api.uiPreferences.getMine, preferences(enabled)));

	return Object.assign(publish, { setContinuation });
}

it('installs a package update on the first click and prevents another request while busy', async () => {
	const installation = Promise.withResolvers<Response>();
	const fetcher = vi.fn().mockReturnValueOnce(installation.promise);

	vi.stubGlobal('fetch', fetcher);
	mount(false)(available);

	const button = await screen.findByRole('button', { name: 'Update available' });

	fireEvent.click(button);
	expect(fetcher).toHaveBeenCalledWith(
		expect.stringContaining('/api/update/install'),
		expect.objectContaining({ method: 'POST' })
	);
	expect(button.hasAttribute('disabled')).toBe(true);
	fireEvent.click(button);
	expect(fetcher).toHaveBeenCalledTimes(1);

	await act(async () => installation.resolve(Response.json({ ...available, status: 'installed' })));
	expect(screen.getByRole('button', { name: 'Restart Sprocket' })).toHaveProperty(
		'disabled',
		false
	);
});

const outdatedKiCad: ConnectorStatus = {
	id: 'kicad',
	name: 'KiCad',
	state: 'installed',
	error: null,
	updateAvailable: true
};

function connectorApi() {
	return {
		fetchConnectors: vi.fn().mockResolvedValue([outdatedKiCad]),
		installOrUpdateConnector: vi.fn().mockResolvedValue({ ...outdatedKiCad, state: 'installing' })
	};
}

it('offers connector updates when Sprocket itself is current', async () => {
	const localApi = connectorApi();
	mount(true, false, localApi)({ ...available, status: 'idle', version: null });
	const button = await screen.findByRole('button', { name: 'Update available' });
	expect(button.title).toBe('KiCad connector');

	await act(async () => fireEvent.click(button));
	expect(localApi.installOrUpdateConnector).toHaveBeenCalledWith('user-test', 'kicad');
	expect(screen.getByRole('button', { name: 'Installing update…' })).toHaveProperty(
		'disabled',
		true
	);
});

it('updates Sprocket and connectors together and restarts only after both finish', async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ ...available, status: 'installing' }));

	vi.stubGlobal('fetch', fetcher);
	const localApi = connectorApi();
	const publish = mount(true, false, localApi);
	publish(available);
	const button = await screen.findByRole('button', { name: 'Update available' });
	await waitFor(() => expect(button.title).toBe('Sprocket 1.1.0, KiCad connector'));

	await act(async () => fireEvent.click(button));
	expect(fetcher).toHaveBeenCalledWith(
		expect.stringContaining('/api/update/install'),
		expect.objectContaining({ method: 'POST' })
	);
	expect(localApi.installOrUpdateConnector).toHaveBeenCalledWith('user-test', 'kicad');

	publish({ ...available, status: 'installed' });
	expect(screen.getByRole('button', { name: 'Installing update…' })).toBeTruthy();
	expect(fetcher).toHaveBeenCalledTimes(1);
});

it('installs outdated connectors before restarting into an installed update', async () => {
	const fetcher = vi.fn();
	vi.stubGlobal('fetch', fetcher);
	const localApi = connectorApi();
	mount(false, false, localApi)({ ...available, status: 'installed' });
	const button = await screen.findByRole('button', { name: 'Update available' });

	await act(async () => fireEvent.click(button));
	expect(screen.queryByRole('dialog')).toBeNull();
	expect(localApi.installOrUpdateConnector).toHaveBeenCalledWith('user-test', 'kicad');
	expect(fetcher).not.toHaveBeenCalled();
});

it('offers the Sprocket restart once a connector update has failed', async () => {
	const localApi = connectorApi();
	localApi.fetchConnectors.mockResolvedValue([{ ...outdatedKiCad, error: 'Download failed' }]);
	mount(true, false, localApi)({ ...available, status: 'installed' });
	expect(await screen.findByText('Download failed')).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Restart Sprocket' })).toBeTruthy();
});

it('restarts once the update installs when automatic continuation is on', async () => {
	const restarted = Promise.withResolvers<Response>();

	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ ...available, status: 'installing' }))
		.mockReturnValueOnce(restarted.promise);

	vi.stubGlobal('fetch', fetcher);
	const publish = mount(true);
	publish(available);
	await act(async () =>
		fireEvent.click(await screen.findByRole('button', { name: 'Update available' }))
	);
	publish({ ...available, status: 'installed' });
	expect(fetcher).toHaveBeenNthCalledWith(
		2,
		expect.stringContaining('/api/update/restart'),
		expect.objectContaining({ method: 'POST' })
	);
	expect(screen.queryByRole('dialog')).toBeNull();
	await act(async () => restarted.reject(new Error('Restart failed')));
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([undefined, true])(
	'restarts without confirmation when automatic continuation is %s',
	async (enabled) => {
		const restarted = Promise.withResolvers<Response>();
		const fetcher = vi.fn().mockReturnValueOnce(restarted.promise);

		vi.stubGlobal('fetch', fetcher);
		mount(enabled)({ ...available, status: 'installed' });
		const button = await screen.findByRole('button', { name: 'Restart Sprocket' });
		await act(async () => fireEvent.click(button));
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringContaining('/api/update/restart'),
			expect.objectContaining({ method: 'POST' })
		);
		expect(button).toHaveProperty('disabled', true);
		expect(button.textContent).toBe('Restarting Sprocket...');
		fireEvent.click(button);
		expect(fetcher).toHaveBeenCalledTimes(1);
		await act(async () => restarted.reject(new Error('Restart failed')));
		expect(screen.getByRole('alert').textContent).toBe('Restart failed');
	}
);

it('drops an install error and waits for a click once the server pushes the installed update', async () => {
	const fetcher = vi.fn().mockRejectedValueOnce(new Error('Connection lost'));
	vi.stubGlobal('fetch', fetcher);
	const publish = mount(true);
	publish(available);
	fireEvent.click(await screen.findByRole('button', { name: 'Update available' }));
	expect(await screen.findByText('Connection lost')).toBeTruthy();

	publish({ ...available, status: 'installed' });
	expect(screen.getByRole('button', { name: 'Restart Sprocket' })).toBeTruthy();
	expect(screen.queryByText('Connection lost')).toBeNull();
	expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
	['the install reports an error', true, { ...available, status: 'error' as const }],
	['automatic continuation is turned on after the click', false, null]
])('waits for a click to restart when %s', async (_, enabled, failure) => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ ...available, status: 'installing' }));

	vi.stubGlobal('fetch', fetcher);
	const publish = mount(enabled);
	publish(available);
	await act(async () =>
		fireEvent.click(await screen.findByRole('button', { name: 'Update available' }))
	);

	if (failure) publish(failure);

	publish({ ...available, status: 'installed' });
	publish.setContinuation(true);
	expect(screen.getByRole('button', { name: 'Restart Sprocket' })).toBeTruthy();
	expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([
	['off', false, false],
	['loading', undefined, true]
])(
	'confirms restart while automatic continuation is %s and lets the user cancel',
	async (_, enabled, loading) => {
		const fetcher = vi.fn().mockRejectedValueOnce(new Error('Restart failed'));

		vi.stubGlobal('fetch', fetcher);
		mount(enabled, loading)({ ...available, status: 'installed' });
		const button = await screen.findByRole('button', { name: 'Restart Sprocket' });
		await act(async () => fireEvent.click(button));
		const dialog = screen.getByRole('dialog', { name: 'Restart Sprocket?' });
		expect(dialog.textContent).toContain('Restarting interrupts active agents');
		expect(fetcher).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
		await act(async () => fireEvent.click(button));
		await act(async () =>
			fireEvent.click(
				within(screen.getByRole('dialog')).getByRole('button', { name: 'Restart Sprocket' })
			)
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	}
);

it('uses the same confirmation before a desktop restart', async () => {
	const install = vi
		.fn()
		.mockResolvedValue({ ...available, method: 'desktop', status: 'installing' });

	window.sprocketDesktopBridge = {
		takeWorkspaceLaunch: async () => null,
		onWorkspaceLaunch: () => () => {},
		openExternal: async () => {},
		focusWindow: async () => true,
		setUnsavedChanges: async () => {},
		updates: {
			getState: async () => ({ ...available, method: 'desktop', status: 'downloaded' }),
			download: vi.fn(),
			install,
			onState: () => () => {}
		}
	};
	mount(false);
	const button = await screen.findByRole('button', { name: 'Restart to update' });
	await act(async () => fireEvent.click(button));
	expect(install).not.toHaveBeenCalled();
	await act(async () =>
		fireEvent.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Restart Sprocket' })
		)
	);
	expect(install).toHaveBeenCalledTimes(1);
});
