// @vitest-environment-options {"url":"https://sprocket.test/"}
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { ChatGptStatus, DesktopApi } from '$lib/types/sprocket';
import SettingsProviders from './settings-providers';

const loginWindow = {
	opener: null,
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
		models: [],
		loginAvailable: true,
		...overrides
	};
}

function createChatGptApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
	const unused = () => Promise.reject(new Error('unexpected desktop API call'));

	return {
		browseFilesystem: unused,
		listWorkspaceSkills: unused,
		searchWorkspace: unused,
		resolveWorkspacePath: unused,
		listProjectAttachments: unused,
		attachProject: unused,
		runAgent: unused,
		fetchTranscriptDisplay: unused,
		fetchTranscriptDisplayDetails: unused,
		watchTranscript: unused,
		watchLiveCompletion: unused,
		clearTranscriptReplica: unused,
		fetchTranscriptAttachment: unused,
		uploadTranscriptAttachment: unused,
		discardTranscriptAttachment: unused,
		watchArtifacts: unused,
		requestRunCancellation: unused,
		startAccountSession: unused,
		endAccountSession: unused,
		fetchChatGptStatus: async () => statusFixture(),
		startChatGptBrowserLogin: unused,
		fetchChatGptBrowserLoginResult: unused,
		cancelChatGptBrowserLogin: async () => {},
		selectChatGptAccount: unused,
		disconnectChatGptAccount: unused,
		...overrides
	};
}

function mount(
	client: ConvexTestClient,
	{
		openAiConfigured = false,
		chatGptStatus = statusFixture(),
		desktopApi = createChatGptApi()
	}: {
		openAiConfigured?: boolean;
		chatGptStatus?: ChatGptStatus;
		desktopApi?: DesktopApi;
	} = {}
) {
	const onConfigurationChange = vi.fn();
	const onChatGptStatusChange = vi.fn();

	function Harness() {
		const [status, setStatus] = useState(chatGptStatus);

		return (
			<SettingsProviders
				userId="user-a"
				desktopApi={desktopApi}
				openAiConfigured={openAiConfigured}
				chatGptStatus={status}
				chatGptLoading={false}
				chatGptStatusError={null}
				loading={false}
				loadError={null}
				onChatGptStatusChange={(next) => {
					setStatus(next);
					onChatGptStatusChange(next);
				}}
				onConfigurationChange={onConfigurationChange}
			/>
		);
	}

	const view = render(
		<ConvexTestProvider client={client}>
			<Harness />
		</ConvexTestProvider>
	);

	return { ...view, onConfigurationChange, onChatGptStatusChange };
}

it('saves an API key, clears the input, and reports the configured provider', async () => {
	const client = new ConvexTestClient();
	const save = vi.fn(async () => null);
	client.handleAction(api.providerCredentials.saveOpenAiKey, save);
	const view = mount(client);
	fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test-not-a-secret' } });
	fireEvent.click(screen.getByRole('button', { name: 'Connect API key' }));
	await waitFor(() =>
		expect(view.onConfigurationChange).toHaveBeenCalledWith({
			provider: 'openai',
			configured: true
		})
	);
	expect(save).toHaveBeenCalledWith({ apiKey: 'sk-test-not-a-secret' });
	expect(screen.getByLabelText('API key')).toHaveProperty('value', '');
});

it('shows key validation failures and permits a successful retry', async () => {
	const client = new ConvexTestClient();
	const save = vi.fn(async () => null).mockRejectedValueOnce(new Error('Invalid API key'));
	client.handleAction(api.providerCredentials.saveOpenAiKey, save);
	const view = mount(client);
	fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test-not-a-secret' } });
	fireEvent.click(screen.getByRole('button', { name: 'Connect API key' }));
	expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid API key');
	fireEvent.click(screen.getByRole('button', { name: 'Connect API key' }));
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
	client.handleAction(api.providerCredentials.removeOpenAiKey, remove);
	const view = mount(client, { openAiConfigured: true });
	fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
	fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
	await waitFor(() =>
		expect(view.onConfigurationChange).toHaveBeenCalledWith({
			provider: 'openai',
			configured: false
		})
	);
	expect(remove).toHaveBeenCalledWith({});
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
		activeConnectionId: 'conn-1',
		models: [{ id: 'test-model', name: 'Test Model' }]
	});

	const start = vi.fn(async () => ({
		state: 'state-1',
		authorizeUrl: 'https://auth.openai.test/authorize?state=state-1'
	}));

	const fetchStatus = vi.fn(async () => connectedStatus);

	const desktopApi = createChatGptApi({
		startChatGptBrowserLogin: start,
		fetchChatGptBrowserLoginResult: async () => ({ status: 'complete' }),
		fetchChatGptStatus: fetchStatus
	});

	const view = mount(client, { desktopApi });
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

	const desktopApi = createChatGptApi({
		startChatGptBrowserLogin: async () => ({
			state: 'state-1',
			authorizeUrl: 'https://auth.openai.test/authorize'
		}),
		fetchChatGptBrowserLoginResult: () => new Promise(() => {})
	});

	mount(new ConvexTestClient(), { desktopApi });
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
		desktopApi: createChatGptApi({ startChatGptBrowserLogin: start })
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
		desktopApi: createChatGptApi({
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
		desktopApi: createChatGptApi({
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
		desktopApi: createChatGptApi({
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

it('cancels a stalled sign-in start and closes its reserved popup immediately', async () => {
	const started = Promise.withResolvers<{ state: string; authorizeUrl: string }>();
	const cancel = vi.fn(async () => {});

	mount(new ConvexTestClient(), {
		desktopApi: createChatGptApi({
			startChatGptBrowserLogin: () => started.promise,
			cancelChatGptBrowserLogin: cancel
		})
	});

	fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	expect(loginWindow.close).toHaveBeenCalledOnce();
	expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeTruthy();
	await act(async () => {
		started.resolve({ state: 'state-1', authorizeUrl: 'https://auth.openai.test/authorize' });
	});
	expect(cancel).toHaveBeenCalledWith({ userId: 'user-a', state: 'state-1' });
});

it('surfaces server-side login errors from the result poll', async () => {
	vi.useFakeTimers();
	const client = new ConvexTestClient();

	const desktopApi = createChatGptApi({
		startChatGptBrowserLogin: async () => ({
			state: 'state-1',
			authorizeUrl: 'https://auth.openai.test/authorize'
		}),
		fetchChatGptBrowserLoginResult: async () => ({
			status: 'error' as const,
			error: 'The sign-in was denied.'
		})
	});

	mount(client, { desktopApi });
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

	const desktopApi = createChatGptApi({
		startChatGptBrowserLogin: async () => ({
			state: 'state-1',
			authorizeUrl: 'https://auth.openai.test/authorize'
		}),
		fetchChatGptBrowserLoginResult: () => result.promise,
		cancelChatGptBrowserLogin: cancel
	});

	const view = mount(client, { desktopApi });
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
	expect(loginWindow.close).toHaveBeenCalledOnce();
	expect(view.onChatGptStatusChange).toHaveBeenCalledTimes(0);
});

it('starts a fresh login after the signed-in user changes', async () => {
	const client = new ConvexTestClient();

	const start = vi.fn(async ({ userId }: { userId: string }) => ({
		state: `state-${userId}`,
		authorizeUrl: `https://auth.openai.com/authorize?state=${userId}`
	}));

	const cancel = vi.fn(async () => {});

	const desktopApi = createChatGptApi({
		startChatGptBrowserLogin: start,
		cancelChatGptBrowserLogin: cancel,
		fetchChatGptBrowserLoginResult: async () => ({ status: 'pending' })
	});

	const renderUser = (userId: string) => (
		<ConvexTestProvider client={client}>
			<SettingsProviders
				userId={userId}
				desktopApi={desktopApi}
				openAiConfigured={false}
				chatGptStatus={statusFixture()}
				chatGptLoading={false}
				chatGptStatusError={null}
				loading={false}
				loadError={null}
				onChatGptStatusChange={() => {}}
				onConfigurationChange={() => {}}
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

	const desktopApi = createChatGptApi({
		startChatGptBrowserLogin: async () => ({
			state: `state-${++startCount}`,
			authorizeUrl: 'https://auth.openai.test/authorize'
		}),
		fetchChatGptBrowserLoginResult: ({ state }: { state: string }) =>
			state === 'state-1' ? firstResult.promise : new Promise(() => {}),
		cancelChatGptBrowserLogin: cancel
	});

	const view = mount(client, { desktopApi });
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_500);
	});
	// Cancel the first login and start a second one.
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	});
	expect(cancel).toHaveBeenCalledWith({ userId: 'user-a', state: 'state-1' });
	expect(loginWindow.close).toHaveBeenCalledOnce();
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	// The first login's late completion must not touch the second login.
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
		activeConnectionId: 'conn-1',
		models: [{ id: 'model-a', name: 'Model A' }]
	});

	const switchedStatus = { ...status, activeConnectionId: 'conn-2' };
	const select = vi.fn(async () => {});

	const desktopApi = createChatGptApi({
		selectChatGptAccount: select,
		fetchChatGptStatus: async () => switchedStatus
	});

	const view = mount(client, { chatGptStatus: status, desktopApi });
	fireEvent.click(screen.getByRole('button', { name: 'Use' }));
	await waitFor(() => expect(view.onChatGptStatusChange).toHaveBeenCalledWith(switchedStatus));
	expect(select).toHaveBeenCalledWith({ userId: 'user-a', connectionId: 'conn-2' });
});

it('signs an account out on the first click and shows the server warning', async () => {
	const client = new ConvexTestClient();

	const status = statusFixture({
		accounts: [{ connectionId: 'conn-1', label: 'a@example.com', connected: true }],
		activeConnectionId: 'conn-1',
		models: [{ id: 'model-a', name: 'Model A' }]
	});

	const signedOutStatus = statusFixture();
	const disconnect = vi.fn(async () => 'Remote revocation could not be confirmed.');

	const desktopApi = createChatGptApi({
		disconnectChatGptAccount: disconnect,
		fetchChatGptStatus: async () => signedOutStatus
	});

	const view = mount(client, { chatGptStatus: status, desktopApi });
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
		activeConnectionId: 'conn-1',
		models: [{ id: 'model-a', name: 'Model A' }]
	});

	const view = mount(new ConvexTestClient(), {
		chatGptStatus: status,
		desktopApi: createChatGptApi({
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

	const desktopApi = createChatGptApi({
		startChatGptBrowserLogin: start,
		fetchChatGptBrowserLoginResult: () => new Promise(() => {})
	});

	mount(client, { chatGptStatus: status, desktopApi });
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
	});
	expect(start).toHaveBeenCalledWith({ userId: 'user-a', connectionId: 'conn-1' });
	expect(loginWindow.location.replace).toHaveBeenCalledWith('https://auth.openai.test/authorize');
	expect(screen.getByText('Signing in…')).toBeTruthy();
});
