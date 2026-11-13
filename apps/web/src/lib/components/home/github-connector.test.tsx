import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GitHubStatus } from '$lib/types/sprocket';
import GitHubConnector, { type GitHubApi } from './github-connector';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const signedIn: GitHubStatus = {
	install: { state: 'installed' },
	enabled: true,
	cliVersion: '2.81.0',
	hosts: [
		{ host: 'github.com', enabled: true, source: 'gitHubCli', login: 'octocat', problem: null },
		{ host: 'ghe.example.com', enabled: true, source: null, login: null, problem: null },
		{ host: 'ghe.env.test', enabled: true, source: 'environment', login: 'robot', problem: null }
	]
};

function mount(status: GitHubStatus = signedIn) {
	const api = {
		fetchGitHubStatus: vi.fn<GitHubApi['fetchGitHubStatus']>(async () => status),
		updateGitHubSettings: vi.fn<GitHubApi['updateGitHubSettings']>(async (_userId, update) => ({
			...status,
			enabled: update.enabled ?? status.enabled
		})),
		signOutGitHub: vi.fn<GitHubApi['signOutGitHub']>(async () => status),
		installConnectorCli: vi.fn<GitHubApi['installConnectorCli']>(async () => ({
			state: 'installing'
		})),
		fetchConnectorSignIn: vi.fn<GitHubApi['fetchConnectorSignIn']>(async () => ({
			state: 'idle'
		})),
		startConnectorSignIn: vi.fn<GitHubApi['startConnectorSignIn']>(async () => ({
			state: 'waiting',
			url: 'https://github.com/login/device',
			code: 'ABCD-1234'
		})),
		cancelConnectorSignIn: vi.fn<GitHubApi['cancelConnectorSignIn']>(async () => ({
			state: 'idle'
		}))
	};

	render(<GitHubConnector userId="user-a" localApi={api} />);

	return api;
}

it('shows how each host signs in', async () => {
	mount();

	expect(await screen.findByText('Signed in as octocat · gh login')).toBeTruthy();
	expect(screen.getByText('2.81.0')).toBeTruthy();
	expect(screen.getByText('Not signed in')).toBeTruthy();
	expect(screen.getByText('Signed in as robot · environment token')).toBeTruthy();
	expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
	expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);
});

it('signs in to a host with a device code and refreshes once it finishes', async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const api = mount();

	fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

	expect(api.startConnectorSignIn).toHaveBeenCalledWith('user-a', {
		connector: 'github',
		host: 'ghe.example.com'
	});
	expect(await screen.findByText('ABCD-1234')).toBeTruthy();
	expect(screen.getByRole('link', { name: 'Open github.com' })).toHaveProperty(
		'href',
		'https://github.com/login/device'
	);
	await act(() => vi.advanceTimersByTimeAsync(2000));
	expect(api.fetchConnectorSignIn).toHaveBeenCalledWith('user-a', {
		connector: 'github',
		host: 'ghe.example.com'
	});
	await waitFor(() => expect(api.fetchGitHubStatus).toHaveBeenCalledTimes(2));
	expect(screen.queryByText('ABCD-1234')).toBeNull();
});

it('signs in to a new Enterprise host', async () => {
	const api = mount();

	fireEvent.click(await screen.findByRole('button', { name: 'Add a GitHub Enterprise host' }));
	fireEvent.change(screen.getByLabelText('Enterprise host'), {
		target: { value: ' GitHub.Acme.com ' }
	});
	fireEvent.submit(screen.getByLabelText('Enterprise host'));

	expect(api.startConnectorSignIn).toHaveBeenCalledWith('user-a', {
		connector: 'github',
		host: 'github.acme.com'
	});
	expect(await screen.findByText('ABCD-1234')).toBeTruthy();
});

it('turns GitHub or one host off on this machine', async () => {
	const api = mount();

	fireEvent.click(await screen.findByRole('switch', { name: 'Use github.com' }));
	await waitFor(() =>
		expect(api.updateGitHubSettings).toHaveBeenLastCalledWith('user-a', {
			host: { host: 'github.com', enabled: false }
		})
	);

	fireEvent.click(screen.getByRole('switch', { name: 'Use GitHub' }));
	await waitFor(() =>
		expect(api.updateGitHubSettings).toHaveBeenLastCalledWith('user-a', { enabled: false })
	);
	expect(await screen.findByText(/GitHub is off/)).toBeTruthy();
});

it('retries a failed GitHub CLI install', async () => {
	const api = mount({ ...signedIn, install: { state: 'failed', error: 'Download failed.' } });

	expect(await screen.findByText('Download failed.')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

	expect(api.installConnectorCli).toHaveBeenCalledWith('user-a', 'github');
	expect(await screen.findByText('Installing GitHub CLI…')).toBeTruthy();
});
