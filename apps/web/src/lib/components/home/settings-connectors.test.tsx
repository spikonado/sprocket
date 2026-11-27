import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { ConnectorStatus, LocalApi, McpConnector } from '$lib/types/sprocket';
import SettingsConnectors, { type ConnectorsApi } from './settings-connectors';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function kicad(overrides: Partial<ConnectorStatus>): ConnectorStatus {
	return {
		id: 'kicad',
		name: 'KiCad',
		state: 'notInstalled',
		error: null,
		updateAvailable: false,
		kicadVersion: null,
		...overrides
	};
}

const linear: McpConnector = {
	id: 'linear',
	name: 'Linear',
	transport: { type: 'stdio', command: 'npx', args: ['-y', 'linear-mcp'], env: ['LINEAR_API_KEY'] }
};

function mount(fetchConnectors: LocalApi['fetchConnectors'], mcp: Partial<ConnectorsApi> = {}) {
	const installOrUpdateConnector = vi.fn<LocalApi['installOrUpdateConnector']>(async () =>
		kicad({ state: 'installing' })
	);

	const uninstallConnector = vi.fn<LocalApi['uninstallConnector']>(async () => kicad({}));
	const installed = { state: 'installed' } as const;
	const unused = async () => Promise.reject(new Error('Not used in this test.'));
	const client = new ConvexTestClient();
	client.registerQuery(api.mcpServers.listMine, []);

	render(
		<ConvexTestProvider client={client}>
			<SettingsConnectors
				userId="user-a"
				localApi={{
					fetchConnectors,
					installOrUpdateConnector,
					uninstallConnector,
					fetchGitHubStatus: async () => ({
						install: installed,
						enabled: true,
						cliVersion: '2.81.0',
						hosts: []
					}),
					fetchVercelStatus: async () => ({
						install: installed,
						version: '50.1.0',
						account: { state: 'signedOut' }
					}),
					updateGitHubSettings: unused,
					signOutGitHub: unused,
					signOutVercel: unused,
					installConnectorCli: unused,
					fetchConnectorSignIn: unused,
					startConnectorSignIn: unused,
					cancelConnectorSignIn: unused,
					fetchMcpConnectors: async () => [],
					addMcpConnector: unused,
					removeMcpConnector: unused,
					fetchMcpTools: unused,
					setMcpToolPolicy: unused,
					...mcp
				}}
			/>
		</ConvexTestProvider>
	);

	return { installOrUpdateConnector };
}

it('installs KiCad and flips the card once the install finishes', async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });

	const fetchConnectors = vi
		.fn<LocalApi['fetchConnectors']>()
		.mockResolvedValueOnce([kicad({})])
		.mockResolvedValue([
			kicad({ state: 'installed', updateAvailable: true, kicadVersion: '10.0.1' })
		]);

	const { installOrUpdateConnector } = mount(fetchConnectors);

	fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

	expect(installOrUpdateConnector).toHaveBeenCalledWith('user-a', 'kicad');
	expect(
		(await screen.findByRole<HTMLButtonElement>('button', { name: 'Installing…' })).disabled
	).toBe(true);
	await act(() => vi.advanceTimersByTimeAsync(2000));
	expect(await screen.findByRole('button', { name: 'Uninstall' })).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
	expect(screen.getByText('10.0.1')).toBeTruthy();
});

it('offers a retry with the install error', async () => {
	mount(async () => [kicad({ state: 'failed', error: 'Not enough disk space.' })]);

	expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
	expect(screen.getByText('Not enough disk space.')).toBeTruthy();
});

it('keeps an older install usable after a failed update', async () => {
	mount(async () => [
		kicad({ state: 'installed', updateAvailable: true, error: 'Download failed.' })
	]);

	expect(await screen.findByRole('button', { name: 'Update' })).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy();
	expect(screen.getByText('Download failed.')).toBeTruthy();
});

it('saves an MCP tool permission and reverts it when the save fails', async () => {
	const setMcpToolPolicy = vi
		.fn<LocalApi['setMcpToolPolicy']>()
		.mockResolvedValueOnce()
		.mockRejectedValueOnce(new Error('Config is read-only.'));

	mount(async () => [], {
		fetchMcpConnectors: async () => [linear],
		fetchMcpTools: async () => [
			{ name: 'create_issue', readOnly: false, destructive: false, policy: 'ask' }
		],
		setMcpToolPolicy
	});

	fireEvent.click(await screen.findByRole('button', { name: 'Tools' }));
	const control = await screen.findByRole('group', { name: 'create_issue permission' });

	const pressed = () =>
		within(control)
			.getAllByRole('button')
			.find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent;

	fireEvent.click(within(control).getByRole('button', { name: 'Enabled' }));
	expect(setMcpToolPolicy).toHaveBeenCalledWith('user-a', 'linear', 'create_issue', 'enabled');
	expect(pressed()).toBe('Enabled');

	fireEvent.click(within(control).getByRole('button', { name: 'Disabled' }));
	expect(await screen.findByText('Config is read-only.')).toBeTruthy();
	expect(pressed()).toBe('Enabled');
});
