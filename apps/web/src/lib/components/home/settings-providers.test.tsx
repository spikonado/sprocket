import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { CompletionProvider } from '@convex/lib/validators';
import SettingsProviders from './settings-providers';

const preferences: Doc<'uiPreferences'> = {
	// SAFETY: this fixture id is only used by the in-memory Convex client.
	_id: 'preferences-test' as Id<'uiPreferences'>,
	_creationTime: 1,
	userId: 'user-test',
	theme: 'light'
};

async function mount(
	data: Doc<'uiPreferences'> | null,
	onOpenCredentials = vi.fn(),
	configuredProviders: CompletionProvider[] = ['spikonado', 'openai', 'chatgpt']
) {
	const client = new ConvexTestClient();
	client.registerQuery(api.uiPreferences.getMine, data);
	client.registerMutation(api.uiPreferences.setProviderOrder, new Promise<null>(() => {}));
	const mutation = vi.spyOn(client, 'mutation');
	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<SettingsProviders
					configuredProviders={configuredProviders}
					onOpenCredentials={onOpenCredentials}
				/>
			</ConvexTestProvider>
		);
	});

	return mutation;
}

function providerNames() {
	return within(screen.getByRole('list', { name: 'Provider order' }))
		.getAllByRole('switch')
		.map((toggle) => toggle.getAttribute('aria-label'));
}

it('lists configured providers in the saved order and saves toggles', async () => {
	const mutation = await mount(null);
	expect(providerNames()).toEqual(['Spikonado', 'OpenAI API', 'ChatGPT Subscription']);

	await act(async () => {
		fireEvent.click(screen.getByRole('switch', { name: 'OpenAI API' }));
	});

	expect(mutation).toHaveBeenCalledWith(
		expect.anything(),
		{
			providerOrder: [
				{ provider: 'spikonado', enabled: true },
				{ provider: 'openai', enabled: false },
				{ provider: 'chatgpt', enabled: true }
			]
		},
		expect.anything()
	);
});

it('hides unconfigured providers and keeps the last shown provider on', async () => {
	const onOpenCredentials = vi.fn();
	await mount(
		{
			...preferences,
			providerOrder: [
				{ provider: 'openai', enabled: true },
				{ provider: 'spikonado', enabled: false },
				{ provider: 'chatgpt', enabled: true }
			]
		},
		onOpenCredentials,
		['spikonado', 'openai']
	);

	expect(providerNames()).toEqual(['OpenAI API', 'Spikonado']);
	expect(screen.getByRole('switch', { name: 'OpenAI API' })).toHaveProperty('disabled', true);
	expect(screen.getByRole('switch', { name: 'Spikonado' })).toHaveProperty('disabled', false);
	fireEvent.click(screen.getByRole('button', { name: 'Set up more providers in BYOK/BYOS' }));
	expect(onOpenCredentials).toHaveBeenCalledOnce();
	expect(
		screen.getByRole('switch', { name: "Restrict subagents to the parent's provider" })
	).toHaveProperty('ariaChecked', 'false');
});
