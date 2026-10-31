import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectorStatus, LocalApi } from '$lib/types/sprocket';
import SettingsConnectors from './settings-connectors';

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
		...overrides
	};
}

function mount(fetchConnectors: LocalApi['fetchConnectors']) {
	const installConnector = vi.fn<LocalApi['installConnector']>(async () =>
		kicad({ state: 'installing' })
	);

	const uninstallConnector = vi.fn<LocalApi['uninstallConnector']>(async () => kicad({}));

	render(
		<SettingsConnectors
			userId="user-a"
			localApi={{ fetchConnectors, installConnector, uninstallConnector }}
		/>
	);

	return { installConnector };
}

it('installs KiCad and flips the card once the install finishes', async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });

	const fetchConnectors = vi
		.fn<LocalApi['fetchConnectors']>()
		.mockResolvedValueOnce([kicad({})])
		.mockResolvedValue([kicad({ state: 'installed', updateAvailable: true })]);

	const { installConnector } = mount(fetchConnectors);

	fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

	expect(installConnector).toHaveBeenCalledWith('user-a', 'kicad');
	expect(
		(await screen.findByRole<HTMLButtonElement>('button', { name: 'Installing…' })).disabled
	).toBe(true);
	await act(() => vi.advanceTimersByTimeAsync(2000));
	expect(await screen.findByRole('button', { name: 'Uninstall' })).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
});

it('offers a retry with the install error', async () => {
	mount(async () => [kicad({ state: 'failed', error: 'Not enough disk space.' })]);

	expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
	expect(screen.getByText('Not enough disk space.')).toBeTruthy();
});
