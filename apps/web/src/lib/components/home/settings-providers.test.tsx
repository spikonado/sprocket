// @vitest-environment-options {"url":"https://sprocket.test/"}
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import SettingsProviders from './settings-providers';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function mount(client: ConvexTestClient, openAiConfigured = false, chatGptConfigured = false) {
	const onConfigurationChange = vi.fn();
	const view = render(
		<ConvexTestProvider client={client}>
			<SettingsProviders
				openAiConfigured={openAiConfigured}
				chatGptConfigured={chatGptConfigured}
				chatGptModelIds={null}
				loading={false}
				loadError={null}
				onConfigurationChange={onConfigurationChange}
			/>
		</ConvexTestProvider>
	);
	return { ...view, onConfigurationChange };
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
	const view = mount(client, true);
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

function deviceLogin() {
	return {
		deviceAuthId: 'device-test',
		userCode: 'TEST-CODE',
		verificationUrl: 'https://login.test/device',
		intervalMs: 1_000,
		expiresAt: Date.now() + 60_000
	};
}

it('completes device sign-in and reports the available models', async () => {
	vi.useFakeTimers();
	const client = new ConvexTestClient();
	client.handleAction(api.providerCredentials.beginChatGptDeviceLogin, async () => deviceLogin());
	client.handleAction(api.providerCredentials.pollChatGptDeviceLogin, async () => ({
		status: 'connected' as const,
		modelIds: ['test-model']
	}));
	const view = mount(client);
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	expect(screen.getByText('TEST-CODE')).toBeTruthy();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_000);
	});
	expect(view.onConfigurationChange).toHaveBeenCalledWith({
		provider: 'chatgpt',
		configured: true,
		chatGptModelIds: ['test-model']
	});
});

it('cancels device sign-in on unmount while its completion is in flight', async () => {
	vi.useFakeTimers();
	const client = new ConvexTestClient();
	const poll =
		Promise.withResolvers<
			FunctionReturnType<typeof api.providerCredentials.pollChatGptDeviceLogin>
		>();
	const cancel = vi.fn(async () => null);
	client.handleAction(api.providerCredentials.beginChatGptDeviceLogin, async () => deviceLogin());
	client.handleAction(api.providerCredentials.pollChatGptDeviceLogin, () => poll.promise);
	client.handleAction(api.providerCredentials.cancelChatGptDeviceLogin, cancel);
	const view = mount(client);
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_000);
	});
	view.unmount();
	await act(async () => {
		poll.resolve({ status: 'connected', modelIds: ['test-model'] });
	});
	expect(cancel).toHaveBeenCalledWith({ deviceAuthId: 'device-test', userCode: 'TEST-CODE' });
	expect(view.onConfigurationChange).toHaveBeenCalledTimes(0);
});

it('labels the connected ChatGPT action as Reconnect ChatGPT', () => {
	const client = new ConvexTestClient();
	mount(client, false, true);
	expect(screen.getByRole('button', { name: 'Reconnect ChatGPT' })).toBeTruthy();
	expect(screen.queryByRole('button', { name: 'Continue with ChatGPT' })).toBeNull();
});

it('links to ChatGPT usage settings', () => {
	const client = new ConvexTestClient();
	mount(client);
	const link = screen.getByRole('link', { name: 'Manage usage' });
	expect(link).toHaveProperty('href', 'https://chatgpt.com/settings/usage');
	expect(link).toHaveProperty('target', '_blank');
});

function confirmChatGptDisconnect() {
	fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
	fireEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
}

it('reports a confirmed ChatGPT revocation without a warning', async () => {
	const client = new ConvexTestClient();
	const remove = vi.fn(async () => ({ revoked: true }));
	client.handleAction(api.providerCredentials.removeChatGptCredential, remove);
	const view = mount(client, false, true);
	confirmChatGptDisconnect();
	await waitFor(() =>
		expect(view.onConfigurationChange).toHaveBeenCalledWith({
			provider: 'chatgpt',
			configured: false
		})
	);
	expect(remove).toHaveBeenCalledWith({ reportRevocation: true });
	expect(screen.queryByText(/remote revocation was not confirmed/)).toBeNull();
});

it('warns when ChatGPT revocation is not confirmed', async () => {
	const client = new ConvexTestClient();
	const remove = vi.fn(async () => ({ revoked: false }));
	client.handleAction(api.providerCredentials.removeChatGptCredential, remove);
	const view = mount(client, false, true);
	confirmChatGptDisconnect();
	await waitFor(() =>
		expect(view.onConfigurationChange).toHaveBeenCalledWith({
			provider: 'chatgpt',
			configured: false
		})
	);
	expect(remove).toHaveBeenCalledWith({ reportRevocation: true });
	const warning = await screen.findByText(/remote revocation was not confirmed/);
	expect(warning).toBeTruthy();
	const settingsLink = screen.getByRole('link', { name: 'ChatGPT settings' });
	expect(settingsLink).toHaveProperty('href', 'https://chatgpt.com/settings');
});

it('warns when ChatGPT removal returns no revocation confirmation', async () => {
	const client = new ConvexTestClient();
	const remove = vi.fn(async () => null);
	client.handleAction(api.providerCredentials.removeChatGptCredential, remove);
	const view = mount(client, false, true);
	confirmChatGptDisconnect();
	await waitFor(() =>
		expect(view.onConfigurationChange).toHaveBeenCalledWith({
			provider: 'chatgpt',
			configured: false
		})
	);
	expect(await screen.findByText(/remote revocation was not confirmed/)).toBeTruthy();
});
