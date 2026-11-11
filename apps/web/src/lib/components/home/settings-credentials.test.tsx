// @vitest-environment-options {"url":"https://sprocket.test/"}
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { ChatGptStatus, ClaudeCodeStatus, LocalApi, MuseStatus } from '$lib/types/sprocket';
import SettingsCredentials from './settings-credentials';

const noApiKeysSaved = {
	openai: false,
	anthropic: false,
	vercel: false,
	openrouter: false,
	opencode: false,
	'opencode-go': false
};

const loginWindow = {
	close: vi.fn(),
	location: { replace: vi.fn() }
};

const openLoginWindow = vi.fn<() => typeof loginWindow | null>(() => loginWindow);

beforeEach(() => {
	openLoginWindow.mockReset().mockReturnValue(loginWindow);
	loginWindow.close.mockReset();
	loginWindow.location.replace.mockReset();
	vi.stubGlobal('open', openLoginWindow);
	vi.stubGlobal('sprocketDesktopBridge', undefined);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function statusFixture(overrides: Partial<ChatGptStatus> = {}): ChatGptStatus {
	return {
		accounts: [],
		activeConnectionId: null,
		loginAvailable: true,
		...overrides
	};
}

function claudeCodeFixture(overrides: Partial<ClaudeCodeStatus> = {}): ClaudeCodeStatus {
	return {
		state: 'installed',
		version: '2.1.300',
		minimumVersion: '2.1.257',
		installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
		error: null,
		...overrides
	};
}

function museFixture(overrides: Partial<MuseStatus> = {}): MuseStatus {
	return {
		state: 'signedOut',
		version: '1.0.0',
		minimumVersion: '1.0.0',
		installCommand: 'curl -fsSL https://muse.test/install.sh | bash',
		account: null,
		error: null,
		...overrides
	};
}

function createChatGptApi(overrides: Partial<LocalApi> = {}): LocalApi {
	const unused = () => Promise.reject(new Error('unexpected desktop API call'));

	return {
		ensureBrowser: unused,
		browserDashboardUrl: 'https://sprocket.test/api/browser/dashboard/',
		watchBrowserStatus: unused,
		watchRunningCommands: vi.fn(() => new Promise<void>(() => {})),
		terminateCommand: vi.fn(async () => ({ terminated: true })),
		browseFilesystem: unused,
		listWorkspaceSkills: unused,
		searchWorkspace: unused,
		watchWorkspaceFiles: unused,
		workspaceEntryKind: unused,
		watchWorkspaceFile: unused,
		readWorkspaceText: unused,
		exportBoard3d: unused,
		writeWorkspaceFile: unused,
		createWorkspaceFile: unused,
		renameWorkspaceFile: unused,
		deleteWorkspaceFile: unused,
		resolveWorkspacePath: unused,
		listProjectAttachments: unused,
		attachProject: unused,
		removeProject: unused,
		runAgent: unused,
		fetchTranscriptDisplay: unused,
		fetchTranscriptDisplayDetails: unused,
		watchTranscript: unused,
		watchLiveCompletion: unused,
		clearTranscriptReplica: unused,
		fetchTranscriptAttachment: unused,
		uploadTranscriptAttachment: unused,
		discardTranscriptAttachment: unused,
		deleteArtifact: unused,
		watchArtifacts: unused,
		requestRunCancellation: unused,
		fetchPullRequestStates: unused,
		startAccountSession: unused,
		endAccountSession: unused,
		fetchChatGptStatus: async () => statusFixture(),
		startChatGptBrowserLogin: unused,
		fetchChatGptBrowserLoginResult: unused,
		cancelChatGptBrowserLogin: async () => {},
		selectChatGptAccount: unused,
		disconnectChatGptAccount: unused,
		fetchGitHubStatus: unused,
		updateGitHubSettings: unused,
		fetchConnectors: unused,
		installOrUpdateConnector: unused,
		uninstallConnector: unused,
		fetchClaudeCodeStatus: async () => claudeCodeFixture(),
		installClaudeCode: unused,
		startClaudeCodeLogin: unused,
		finishClaudeCodeLogin: unused,
		cancelClaudeCodeLogin: async () => {},
		fetchMuseStatus: async () => museFixture(),
		installMuse: unused,
		startMuseLogin: unused,
		cancelMuseLogin: async () => {},
		...overrides
	};
}

function mount(
	client: ConvexTestClient,
	{
		apiKeysSaved = noApiKeysSaved,
		claudeTokenSaved = false,
		claudeCodeStatus = claudeCodeFixture(),
		museStatus = museFixture(),
		chatGptStatus = statusFixture(),
		localApi = createChatGptApi()
	}: {
		apiKeysSaved?: typeof noApiKeysSaved;
		claudeTokenSaved?: boolean;
		claudeCodeStatus?: ClaudeCodeStatus;
		museStatus?: MuseStatus;
		chatGptStatus?: ChatGptStatus;
		localApi?: LocalApi;
	} = {}
) {
	const onConfigurationChange = vi.fn();
	const onProviderConnected = vi.fn();
	const onChatGptStatusChange = vi.fn();
	const onClaudeCodeStatusChange = vi.fn();
	const onMuseStatusChange = vi.fn();

	function Harness() {
		const [status, setStatus] = useState(chatGptStatus);
		const [claudeStatus, setClaudeStatus] = useState(claudeCodeStatus);
		const [currentMuseStatus, setMuseStatus] = useState(museStatus);

		return (
			<SettingsCredentials
				userId="user-a"
				localApi={localApi}
				apiKeysSaved={apiKeysSaved}
				claudeTokenSaved={claudeTokenSaved}
				claudeCodeStatus={claudeStatus}
				claudeCodeStatusError={null}
				museStatus={currentMuseStatus}
				museStatusError={null}
				chatGptStatus={status}
				chatGptLoading={false}
				chatGptStatusError={null}
				loading={false}
				loadError={null}
				onChatGptStatusChange={(next) => {
					setStatus(next);
					onChatGptStatusChange(next);
				}}
				onClaudeCodeStatusChange={(next) => {
					setClaudeStatus(next);
					onClaudeCodeStatusChange(next);
				}}
				onMuseStatusChange={(next) => {
					setMuseStatus(next);
					onMuseStatusChange(next);
				}}
				onConfigurationChange={onConfigurationChange}
				onProviderConnected={onProviderConnected}
			/>
		);
	}

	const view = render(
		<ConvexTestProvider client={client}>
			<Harness />
		</ConvexTestProvider>
	);

	return {
		...view,
		onConfigurationChange,
		onProviderConnected,
		onChatGptStatusChange,
		onClaudeCodeStatusChange,
		onMuseStatusChange
	};
}

it('saves an API key, clears the input, and reports the configured provider', async () => {
	const client = new ConvexTestClient();
	const save = vi.fn(async () => null);
	client.handleAction(api.providerCredentials.saveApiKey, save);
	const view = mount(client);
	const card = within(screen.getByRole('region', { name: 'Vercel AI Gateway' }));
	fireEvent.change(card.getByLabelText('API key'), { target: { value: 'vck_not-a-secret' } });
	fireEvent.click(card.getByRole('button', { name: 'Connect API key' }));
	await waitFor(() =>
		expect(view.onConfigurationChange).toHaveBeenCalledWith({
			provider: 'vercel',
			configured: true
		})
	);
	expect(save).toHaveBeenCalledWith({ provider: 'vercel', apiKey: 'vck_not-a-secret' });
	expect(view.onProviderConnected).toHaveBeenCalledWith('vercel');
	expect(card.getByLabelText('API key')).toHaveProperty('value', '');
});

it('shows the Claude Code install command and installs it from the button', async () => {
	const installing = claudeCodeFixture({ state: 'installing', version: null });
	const install = vi.fn(async () => installing);

	const view = mount(new ConvexTestClient(), {
		claudeCodeStatus: claudeCodeFixture({ state: 'notInstalled', version: null }),
		localApi: createChatGptApi({ installClaudeCode: install })
	});

	expect(screen.getByText('curl -fsSL https://claude.ai/install.sh | bash')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'Install Claude Code' }));
	expect(await screen.findByRole('button', { name: 'Installing…' })).toHaveProperty(
		'disabled',
		true
	);
	expect(install).toHaveBeenCalledWith('user-a');
	expect(view.onClaudeCodeStatusChange).toHaveBeenCalledWith(installing);
	expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).toBeNull();
});

it('signs in to Muse with a device code and waits until Muse is ready', async () => {
	vi.useFakeTimers();
	const ready = museFixture({ state: 'ready', account: 'a@example.com' });

	const fetchMuseStatus = vi
		.fn<() => Promise<MuseStatus>>()
		.mockResolvedValueOnce(museFixture())
		.mockResolvedValue(ready);

	const view = mount(new ConvexTestClient(), {
		localApi: createChatGptApi({
			startMuseLogin: async () => ({
				loginId: 'login-1',
				verificationUrl: 'https://muse.test/device',
				userCode: 'ABCD-EFGH'
			}),
			fetchMuseStatus
		})
	});

	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Sign in with Muse' }));
	});
	expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
	expect(screen.getByRole('link', { name: 'Open sign-in page' })).toHaveProperty(
		'href',
		'https://muse.test/device'
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(4_000);
	});
	expect(view.onMuseStatusChange).toHaveBeenLastCalledWith(ready);
	expect(view.onProviderConnected).toHaveBeenCalledWith('muse');
	expect(screen.getByText('Connected as a@example.com')).toBeTruthy();
	expect(screen.queryByText('ABCD-EFGH')).toBeNull();
});

it('links to a plan upgrade when the Muse plan lacks Muse Wonder Full', () => {
	mount(new ConvexTestClient(), { museStatus: museFixture({ state: 'planRequired' }) });
	expect(screen.getByRole('link', { name: 'Upgrade in Accounts Center' })).toHaveProperty(
		'href',
		'https://accountscenter.meta.com/'
	);
	expect(screen.queryByRole('button', { name: 'Sign in with Muse' })).toBeNull();
});

it('signs in with Claude and saves the token', async () => {
	const client = new ConvexTestClient();
	const save = vi.fn(async () => null);
	client.handleAction(api.providerCredentials.saveClaudeToken, save);
	const finish = vi.fn(async () => 'sk-ant-oat01-test');

	const view = mount(client, {
		localApi: createChatGptApi({
			startClaudeCodeLogin: async () => ({
				loginId: 'login-1',
				url: 'https://claude.test/oauth'
			}),
			finishClaudeCodeLogin: finish
		})
	});

	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
	});
	expect(openLoginWindow).toHaveBeenCalledWith('about:blank', '_blank');
	expect(loginWindow.location.replace).toHaveBeenCalledWith('https://claude.test/oauth');
	fireEvent.change(screen.getByLabelText('Paste the code Claude shows after you sign in'), {
		target: { value: 'code-1' }
	});
	fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
	await waitFor(() =>
		expect(view.onConfigurationChange).toHaveBeenCalledWith({
			provider: 'claude',
			configured: true
		})
	);
	expect(finish).toHaveBeenCalledWith('user-a', 'login-1', 'code-1');
	expect(save).toHaveBeenCalledWith({ token: 'sk-ant-oat01-test' });
});

it('shows a rejected Claude code and lets the user sign in again', async () => {
	mount(new ConvexTestClient(), {
		localApi: createChatGptApi({
			startClaudeCodeLogin: async () => ({ loginId: 'login-1', url: 'https://claude.test/oauth' }),
			finishClaudeCodeLogin: async () => {
				throw new Error('Claude rejected the code. Sign in again.');
			}
		})
	});

	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
	});
	fireEvent.change(screen.getByLabelText('Paste the code Claude shows after you sign in'), {
		target: { value: 'wrong' }
	});
	fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
	expect((await screen.findByRole('alert')).textContent).toBe(
		'Claude rejected the code. Sign in again.'
	);
	expect(screen.getByRole('button', { name: 'Sign in with Claude' })).toBeTruthy();
});

it('shows a saved Claude token as connected without a sign-in button', () => {
	mount(new ConvexTestClient(), { claudeTokenSaved: true });
	expect(screen.getByText('Connected')).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).toBeNull();
});

it('shows key validation failures and permits a successful retry', async () => {
	const client = new ConvexTestClient();
	const save = vi.fn(async () => null).mockRejectedValueOnce(new Error('Invalid API key'));
	client.handleAction(api.providerCredentials.saveApiKey, save);
	const view = mount(client);
	const card = within(screen.getByRole('region', { name: 'OpenAI API' }));
	fireEvent.change(card.getByLabelText('API key'), { target: { value: 'sk-test-not-a-secret' } });
	fireEvent.click(card.getByRole('button', { name: 'Connect API key' }));
	expect(await card.findByRole('alert')).toHaveProperty('textContent', 'Invalid API key');
	fireEvent.click(card.getByRole('button', { name: 'Connect API key' }));
	await waitFor(() =>
		expect(view.onConfigurationChange).toHaveBeenCalledWith({
			provider: 'openai',
			configured: true
		})
	);
});

it('removes a configured key after confirmation', async () => {
	const client = new ConvexTestClient();
	const remove = vi.fn(async () => null);
	client.handleAction(api.providerCredentials.removeApiKey, remove);
	const view = mount(client, { apiKeysSaved: { ...noApiKeysSaved, anthropic: true } });
	fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
	fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
	await waitFor(() =>
		expect(view.onConfigurationChange).toHaveBeenCalledWith({
			provider: 'anthropic',
			configured: false
		})
	);
	expect(remove).toHaveBeenCalledWith({ provider: 'anthropic' });
});

it('explains that local sign-in is unavailable when the server cannot log in', () => {
	mount(new ConvexTestClient(), { chatGptStatus: statusFixture({ loginAvailable: false }) });
	expect(screen.getByText(/sign-in runs through the local Sprocket server/)).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Continue with ChatGPT' })).toBeNull();
});

it('opens browser sign-in on the first click and reports the refreshed status', async () => {
	vi.useFakeTimers();
	const client = new ConvexTestClient();

	const connectedStatus = statusFixture({
		accounts: [{ connectionId: 'conn-1', label: 'a@example.com', connected: true }],
		activeConnectionId: 'conn-1'
	});

	const start = vi.fn(async () => ({
		state: 'state-1',
		authorizeUrl: 'https://auth.openai.test/authorize?state=state-1'
	}));

	const fetchStatus = vi.fn(async () => connectedStatus);

	const localApi = createChatGptApi({
		startChatGptBrowserLogin: start,
		fetchChatGptBrowserLoginResult: async () => ({ status: 'complete' }),
		fetchChatGptStatus: fetchStatus
	});

	const view = mount(client, { localApi });
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	expect(start).toHaveBeenCalledWith({ userId: 'user-a' });
	expect(openLoginWindow).toHaveBeenCalledWith('about:blank', '_blank');
	expect(loginWindow.location.replace).toHaveBeenCalledWith(
		'https://auth.openai.test/authorize?state=state-1'
	);
	expect(screen.getByText('Signing in…')).toBeTruthy();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_500);
	});
	expect(view.onChatGptStatusChange).toHaveBeenCalledWith(connectedStatus);
});

it('opens desktop sign-in without creating a browser popup', async () => {
	vi.useFakeTimers();
	const openExternal = vi.fn(async () => {});
	vi.stubGlobal('sprocketDesktopBridge', { openExternal });

	const localApi = createChatGptApi({
		startChatGptBrowserLogin: async () => ({
			state: 'state-1',
			authorizeUrl: 'https://auth.openai.test/authorize'
		}),
		fetchChatGptBrowserLoginResult: () => new Promise(() => {})
	});

	mount(new ConvexTestClient(), { localApi });
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	expect(openExternal).toHaveBeenCalledWith('https://auth.openai.test/authorize');
	expect(openLoginWindow).toHaveBeenCalledTimes(0);
	expect(screen.getByText('Signing in…')).toBeTruthy();
});

it('reports a blocked browser popup before starting a server login', async () => {
	openLoginWindow.mockReturnValue(null);
	const start = vi.fn();
	mount(new ConvexTestClient(), {
		localApi: createChatGptApi({ startChatGptBrowserLogin: start })
	});
	fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	expect(await screen.findByRole('alert')).toHaveProperty(
		'textContent',
		'Your browser blocked the sign-in window. Allow popups and try again.'
	);
	expect(start).toHaveBeenCalledTimes(0);
});

it('cancels a server login when the desktop browser cannot open', async () => {
	const openExternal = vi.fn(async () => {
		throw new Error('Could not open the browser.');
	});

	vi.stubGlobal('sprocketDesktopBridge', { openExternal });

	const cancel = vi.fn(async () => {});
	mount(new ConvexTestClient(), {
		localApi: createChatGptApi({
			startChatGptBrowserLogin: async () => ({
				state: 'state-1',
				authorizeUrl: 'https://auth.openai.test/authorize'
			}),
			cancelChatGptBrowserLogin: cancel
		})
	});
	fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	expect(await screen.findByRole('alert')).toHaveProperty(
		'textContent',
		'Could not open the browser.'
	);
	expect(cancel).toHaveBeenCalledWith({ userId: 'user-a', state: 'state-1' });
});

it('closes the reserved popup when starting sign-in fails', async () => {
	mount(new ConvexTestClient(), {
		localApi: createChatGptApi({
			startChatGptBrowserLogin: async () => {
				throw new Error('Could not start sign-in.');
			}
		})
	});
	fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	expect(await screen.findByRole('alert')).toHaveProperty(
		'textContent',
		'Could not start sign-in.'
	);
	expect(loginWindow.close).toHaveBeenCalledOnce();
});

it('reserves the popup before waiting for sign-in and closes a stale start', async () => {
	const started = Promise.withResolvers<{ state: string; authorizeUrl: string }>();
	const cancel = vi.fn(async () => {});

	const view = mount(new ConvexTestClient(), {
		localApi: createChatGptApi({
			startChatGptBrowserLogin: () => started.promise,
			cancelChatGptBrowserLogin: cancel
		})
	});

	fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	expect(openLoginWindow).toHaveBeenCalledOnce();
	view.unmount();
	await act(async () => {
		started.resolve({ state: 'state-1', authorizeUrl: 'https://auth.openai.test/authorize' });
	});
	expect(cancel).toHaveBeenCalledWith({ userId: 'user-a', state: 'state-1' });
	expect(loginWindow.close).toHaveBeenCalledOnce();
});

it('cancels a stalled sign-in start and closes its reserved popup once it resolves', async () => {
	const started = Promise.withResolvers<{ state: string; authorizeUrl: string }>();
	const cancel = vi.fn(async () => {});

	mount(new ConvexTestClient(), {
		localApi: createChatGptApi({
			startChatGptBrowserLogin: () => started.promise,
			cancelChatGptBrowserLogin: cancel
		})
	});

	fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
	await act(async () => {
		started.resolve({ state: 'state-1', authorizeUrl: 'https://auth.openai.test/authorize' });
	});
	expect(cancel).toHaveBeenCalledWith({ userId: 'user-a', state: 'state-1' });
	expect(loginWindow.close).toHaveBeenCalledOnce();
});

it('surfaces server-side login errors from the result poll', async () => {
	vi.useFakeTimers();
	const client = new ConvexTestClient();

	const localApi = createChatGptApi({
		startChatGptBrowserLogin: async () => ({
			state: 'state-1',
			authorizeUrl: 'https://auth.openai.test/authorize'
		}),
		fetchChatGptBrowserLoginResult: async () => ({
			status: 'error' as const,
			error: 'The sign-in was denied.'
		})
	});

	mount(client, { localApi });
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_500);
	});
	expect(screen.getByRole('alert').textContent).toBe('The sign-in was denied.');
});

it('cancels the pending browser login on unmount while its poll is in flight', async () => {
	vi.useFakeTimers();
	const client = new ConvexTestClient();
	const result = Promise.withResolvers<{ status: 'pending' | 'complete' | 'error' }>();
	const cancel = vi.fn(async () => {});

	const localApi = createChatGptApi({
		startChatGptBrowserLogin: async () => ({
			state: 'state-1',
			authorizeUrl: 'https://auth.openai.test/authorize'
		}),
		fetchChatGptBrowserLoginResult: () => result.promise,
		cancelChatGptBrowserLogin: cancel
	});

	const view = mount(client, { localApi });
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_500);
	});
	view.unmount();
	await act(async () => {
		result.resolve({ status: 'complete' });
	});
	expect(cancel).toHaveBeenCalledWith({ userId: 'user-a', state: 'state-1' });
	expect(view.onChatGptStatusChange).toHaveBeenCalledTimes(0);
});

it('starts a fresh login after the signed-in user changes', async () => {
	const client = new ConvexTestClient();

	const start = vi.fn(async ({ userId }: { userId: string }) => ({
		state: `state-${userId}`,
		authorizeUrl: `https://auth.openai.com/authorize?state=${userId}`
	}));

	const cancel = vi.fn(async () => {});

	const localApi = createChatGptApi({
		startChatGptBrowserLogin: start,
		cancelChatGptBrowserLogin: cancel,
		fetchChatGptBrowserLoginResult: async () => ({ status: 'pending' })
	});

	const renderUser = (userId: string) => (
		<ConvexTestProvider client={client}>
			<SettingsCredentials
				userId={userId}
				localApi={localApi}
				apiKeysSaved={noApiKeysSaved}
				claudeTokenSaved={false}
				claudeCodeStatus={claudeCodeFixture()}
				claudeCodeStatusError={null}
				museStatus={museFixture()}
				museStatusError={null}
				chatGptStatus={statusFixture()}
				chatGptLoading={false}
				chatGptStatusError={null}
				loading={false}
				loadError={null}
				onChatGptStatusChange={() => {}}
				onClaudeCodeStatusChange={() => {}}
				onMuseStatusChange={() => {}}
				onConfigurationChange={() => {}}
				onProviderConnected={() => {}}
			/>
		</ConvexTestProvider>
	);

	const view = render(renderUser('user-a'));
	fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	await screen.findByText('Signing in…');
	view.rerender(renderUser('user-b'));
	expect(cancel).toHaveBeenCalledWith({ userId: 'user-a', state: 'state-user-a' });
	fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	await waitFor(() => expect(start).toHaveBeenLastCalledWith({ userId: 'user-b' }));
});

it('ignores a stale login completion after the user cancels and starts again', async () => {
	vi.useFakeTimers();
	const client = new ConvexTestClient();
	const firstResult = Promise.withResolvers<{ status: 'pending' | 'complete' | 'error' }>();
	const cancel = vi.fn(async () => {});
	let startCount = 0;

	const localApi = createChatGptApi({
		startChatGptBrowserLogin: async () => ({
			state: `state-${++startCount}`,
			authorizeUrl: 'https://auth.openai.test/authorize'
		}),
		fetchChatGptBrowserLoginResult: ({ state }: { state: string }) =>
			state === 'state-1' ? firstResult.promise : new Promise(() => {}),
		cancelChatGptBrowserLogin: cancel
	});

	const view = mount(client, { localApi });
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_500);
	});
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	});
	expect(cancel).toHaveBeenCalledWith({ userId: 'user-a', state: 'state-1' });
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	await act(async () => {
		firstResult.resolve({ status: 'complete' });
	});
	expect(view.onChatGptStatusChange).toHaveBeenCalledTimes(0);
	expect(screen.getByText('Signing in…')).toBeTruthy();
});

it('switches the active account and reports the refreshed status', async () => {
	const client = new ConvexTestClient();

	const status = statusFixture({
		accounts: [
			{ connectionId: 'conn-1', label: 'a@example.com', connected: true },
			{ connectionId: 'conn-2', label: 'b@example.com', connected: true }
		],
		activeConnectionId: 'conn-1'
	});

	const switchedStatus = { ...status, activeConnectionId: 'conn-2' };
	const select = vi.fn(async () => {});

	const localApi = createChatGptApi({
		selectChatGptAccount: select,
		fetchChatGptStatus: async () => switchedStatus
	});

	const view = mount(client, { chatGptStatus: status, localApi });
	fireEvent.click(screen.getByRole('button', { name: 'Use' }));
	await waitFor(() => expect(view.onChatGptStatusChange).toHaveBeenCalledWith(switchedStatus));
	expect(select).toHaveBeenCalledWith({ userId: 'user-a', connectionId: 'conn-2' });
});

it('signs an account out on the first click and shows the server warning', async () => {
	const client = new ConvexTestClient();

	const status = statusFixture({
		accounts: [{ connectionId: 'conn-1', label: 'a@example.com', connected: true }],
		activeConnectionId: 'conn-1'
	});

	const signedOutStatus = statusFixture();
	const disconnect = vi.fn(async () => 'Remote revocation could not be confirmed.');

	const localApi = createChatGptApi({
		disconnectChatGptAccount: disconnect,
		fetchChatGptStatus: async () => signedOutStatus
	});

	const view = mount(client, { chatGptStatus: status, localApi });
	fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
	await waitFor(() => expect(view.onChatGptStatusChange).toHaveBeenCalledWith(signedOutStatus));
	expect(disconnect).toHaveBeenCalledWith({ userId: 'user-a', connectionId: 'conn-1' });
	expect(screen.getByText('Remote revocation could not be confirmed.')).toBeTruthy();
	expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
});

it('forgets a signed-out account before a follow-up status check settles', async () => {
	const pending = Promise.withResolvers<ChatGptStatus>();

	const status = statusFixture({
		accounts: [{ connectionId: 'conn-1', label: 'Account A', connected: true }],
		activeConnectionId: 'conn-1'
	});

	const view = mount(new ConvexTestClient(), {
		chatGptStatus: status,
		localApi: createChatGptApi({
			disconnectChatGptAccount: async () => null,
			fetchChatGptStatus: () => pending.promise
		})
	});

	fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
	await waitFor(() => expect(view.onChatGptStatusChange).toHaveBeenCalledWith(statusFixture()));
	expect(screen.getByText('Not connected')).toBeTruthy();
	await act(async () => {
		pending.reject(new Error('Could not load remaining account status.'));
	});
	expect(await screen.findByRole('alert')).toHaveProperty(
		'textContent',
		'Could not load remaining account status.'
	);
	expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
});

it('reconnects a signed-out account through the browser flow', async () => {
	vi.useFakeTimers();
	const client = new ConvexTestClient();

	const status = statusFixture({
		accounts: [{ connectionId: 'conn-1', label: 'a@example.com', connected: false }],
		activeConnectionId: null
	});

	const start = vi.fn(async () => ({
		state: 'state-1',
		authorizeUrl: 'https://auth.openai.test/authorize'
	}));

	const localApi = createChatGptApi({
		startChatGptBrowserLogin: start,
		fetchChatGptBrowserLoginResult: () => new Promise(() => {})
	});

	mount(client, { chatGptStatus: status, localApi });
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
	});
	expect(start).toHaveBeenCalledWith({ userId: 'user-a', connectionId: 'conn-1' });
	expect(loginWindow.location.replace).toHaveBeenCalledWith('https://auth.openai.test/authorize');
	expect(screen.getByText('Signing in…')).toBeTruthy();
});
