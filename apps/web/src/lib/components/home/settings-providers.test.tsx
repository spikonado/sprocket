// @vitest-environment-options {"url":"https://sprocket.test/"}
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { ChatGptStatus, DesktopApi } from '$lib/types/sprocket';
import SettingsProviders from './settings-providers';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
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
	const view = render(
		<ConvexTestProvider client={client}>
			<SettingsProviders
				userId="user-a"
				desktopApi={desktopApi}
				openAiConfigured={openAiConfigured}
				chatGptStatus={chatGptStatus}
				chatGptLoading={false}
				chatGptStatusError={null}
				loading={false}
				loadError={null}
				onChatGptStatusChange={onChatGptStatusChange}
				onConfigurationChange={onConfigurationChange}
			/>
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

it('completes browser sign-in and reports the refreshed status', async () => {
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
	expect(screen.getByText('Waiting for approval…')).toBeTruthy();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_500);
	});
	expect(view.onChatGptStatusChange).toHaveBeenCalledWith(connectedStatus);
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
	expect(view.onChatGptStatusChange).toHaveBeenCalledTimes(0);
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
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	// The first login's late completion must not touch the second login.
	await act(async () => {
		firstResult.resolve({ status: 'complete' });
	});
	expect(view.onChatGptStatusChange).toHaveBeenCalledTimes(0);
	expect(screen.getByText('Waiting for approval…')).toBeTruthy();
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

it('signs an account out after confirmation and shows the server warning', async () => {
	const client = new ConvexTestClient();
	const status = statusFixture({
		accounts: [{ connectionId: 'conn-1', label: 'a@example.com', connected: true }],
		activeConnectionId: 'conn-1',
		models: [{ id: 'model-a', name: 'Model A' }]
	});
	const signedOutStatus = statusFixture();
	const disconnect = vi.fn(async () => 'In-flight runs keep using the previous account.');
	const desktopApi = createChatGptApi({
		disconnectChatGptAccount: disconnect,
		fetchChatGptStatus: async () => signedOutStatus
	});
	const view = mount(client, { chatGptStatus: status, desktopApi });
	fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
	fireEvent.click(screen.getByRole('button', { name: 'Confirm sign out' }));
	await waitFor(() => expect(view.onChatGptStatusChange).toHaveBeenCalledWith(signedOutStatus));
	expect(disconnect).toHaveBeenCalledWith({ userId: 'user-a', connectionId: 'conn-1' });
	expect(screen.getByText('In-flight runs keep using the previous account.')).toBeTruthy();
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
	expect(screen.getByText('Waiting for approval…')).toBeTruthy();
});
