import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { LocalApi, GitHubStatus } from '$lib/types/sprocket';
import SettingsVersionControl from './settings-version-control';

afterEach(cleanup);

const signedIn: GitHubStatus = {
	enabled: true,
	cliVersion: '2.81.0',
	savedTokensProblem: null,
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
	const client = new ConvexTestClient();
	const saveToken = vi.fn(async () => null);
	const removeToken = vi.fn(async () => null);
	client.handleAction(api.githubCredentials.saveToken, saveToken);
	client.handleAction(api.githubCredentials.removeToken, removeToken);
	const fetchGitHubStatus = vi.fn<LocalApi['fetchGitHubStatus']>(async () => status);

	const updateGitHubSettings = vi.fn<LocalApi['updateGitHubSettings']>(async (_userId, update) => ({
		...status,
		enabled: update.enabled ?? status.enabled
	}));

	render(
		<ConvexTestProvider client={client}>
			<SettingsVersionControl
				userId="user-a"
				localApi={{ fetchGitHubStatus, updateGitHubSettings }}
			/>
		</ConvexTestProvider>
	);

	return { saveToken, fetchGitHubStatus, updateGitHubSettings };
}

it('shows the account and credential source of each GitHub host', async () => {
	mount(signedIn);

	expect(await screen.findByText('Signed in as octocat · gh login')).toBeTruthy();
	expect(screen.getByText('2.81.0')).toBeTruthy();
	expect(
		screen.getByText('Not signed in. Run gh auth login --hostname ghe.example.com, or add a token.')
	).toBeTruthy();
});

it('saves a token to the account, then checks it on this machine', async () => {
	const { saveToken, fetchGitHubStatus } = mount(signedIn);

	fireEvent.click((await screen.findAllByRole('button', { name: 'Add token' }))[1]!);
	fireEvent.change(screen.getByLabelText('Token for ghe.example.com'), {
		target: { value: 'ghp_secret' }
	});
	fireEvent.click(screen.getByRole('button', { name: 'Save' }));

	await waitFor(() =>
		expect(saveToken).toHaveBeenCalledWith({ host: 'ghe.example.com', token: 'ghp_secret' })
	);
	await waitFor(() => expect(fetchGitHubStatus).toHaveBeenCalledTimes(2));
	expect(fetchGitHubStatus).toHaveBeenLastCalledWith('user-a');
	await waitFor(() => expect(screen.queryByLabelText('Token for ghe.example.com')).toBeNull());
});

it('turns GitHub or one host off on this machine', async () => {
	const { updateGitHubSettings } = mount(signedIn);

	fireEvent.click(await screen.findByRole('switch', { name: 'Use github.com' }));
	await waitFor(() =>
		expect(updateGitHubSettings).toHaveBeenLastCalledWith('user-a', {
			host: { host: 'github.com', enabled: false }
		})
	);

	fireEvent.click(screen.getByRole('switch', { name: 'Use GitHub' }));
	await waitFor(() =>
		expect(updateGitHubSettings).toHaveBeenLastCalledWith('user-a', { enabled: false })
	);
	expect(await screen.findByText(/GitHub is off/)).toBeTruthy();
});

it('adds an Enterprise host with its token', async () => {
	const { saveToken } = mount(signedIn);

	fireEvent.click(await screen.findByRole('button', { name: 'Add a GitHub Enterprise host' }));
	fireEvent.change(screen.getByLabelText('Enterprise host'), {
		target: { value: ' github.acme.com ' }
	});
	fireEvent.change(screen.getByLabelText('Enterprise token'), { target: { value: 'ghp_acme' } });
	fireEvent.click(screen.getByRole('button', { name: 'Add' }));

	await waitFor(() =>
		expect(saveToken).toHaveBeenCalledWith({ host: 'github.acme.com', token: 'ghp_acme' })
	);
	await waitFor(() => expect(screen.queryByLabelText('Enterprise host')).toBeNull());
});
