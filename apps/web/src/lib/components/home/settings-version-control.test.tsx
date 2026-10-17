import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { DesktopApi, GitHubStatus } from '$lib/types/sprocket';
import SettingsVersionControl from './settings-version-control';

const signedIn: GitHubStatus = {
	enabled: true,
	cliVersion: '2.81.0',
	hosts: [
		{
			host: 'github.com',
			enabled: true,
			hasSavedToken: false,
			source: 'gitHubCli',
			login: 'octocat',
			problem: null
		},
		{
			host: 'ghe.example.com',
			enabled: true,
			hasSavedToken: false,
			source: null,
			login: null,
			problem: null
		}
	]
};

function mount(status: GitHubStatus) {
	const fetchGitHubStatus = vi.fn(async () => status);

	const updateGitHubSettings = vi.fn<DesktopApi['updateGitHubSettings']>(async (update) => ({
		...status,
		enabled: update.enabled ?? status.enabled
	}));

	render(<SettingsVersionControl desktopApi={{ fetchGitHubStatus, updateGitHubSettings }} />);

	return updateGitHubSettings;
}

it('shows the account and credential source of each GitHub host', async () => {
	mount(signedIn);

	expect(await screen.findByText('Signed in as octocat · gh login')).toBeTruthy();
	expect(screen.getByText('2.81.0')).toBeTruthy();
	expect(
		screen.getByText('Not signed in. Run gh auth login --hostname ghe.example.com, or add a token.')
	).toBeTruthy();
});

it('saves a token for one host and turns GitHub or a host off', async () => {
	const updateGitHubSettings = mount(signedIn);

	fireEvent.click((await screen.findAllByRole('button', { name: 'Add token' }))[1]!);
	fireEvent.change(screen.getByLabelText('Token for ghe.example.com'), {
		target: { value: 'ghp_secret' }
	});
	fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	await waitFor(() =>
		expect(updateGitHubSettings).toHaveBeenCalledWith({
			host: { host: 'ghe.example.com', token: 'ghp_secret' }
		})
	);
	await waitFor(() => expect(screen.queryByLabelText('Token for ghe.example.com')).toBeNull());

	fireEvent.click(screen.getByRole('switch', { name: 'Use github.com' }));
	await waitFor(() =>
		expect(updateGitHubSettings).toHaveBeenLastCalledWith({
			host: { host: 'github.com', enabled: false }
		})
	);

	fireEvent.click(screen.getByRole('switch', { name: 'Use GitHub' }));
	await waitFor(() => expect(updateGitHubSettings).toHaveBeenLastCalledWith({ enabled: false }));
	expect(await screen.findByText(/GitHub is off/)).toBeTruthy();
});
