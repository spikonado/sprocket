import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import SettingsProviders from './settings-providers';

const preferences: Doc<'uiPreferences'> = {
	// SAFETY: this fixture id is only used by the in-memory Convex client.
	_id: 'preferences-test' as Id<'uiPreferences'>,
	_creationTime: 1,
	userId: 'user-test',
	theme: 'light'
};

async function mount(data: Doc<'uiPreferences'> | null, onOpenCredentials = vi.fn()) {
	const client = new ConvexTestClient();
	client.registerQuery(api.uiPreferences.getMine, data);
	client.registerMutation(api.uiPreferences.setProviderOrder, new Promise<null>(() => {}));
	const mutation = vi.spyOn(client, 'mutation');
	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<SettingsProviders
					configuredProviders={['spikonado']}
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

it('reorders providers and saves the full order', async () => {
	const mutation = await mount(null);
	expect(providerNames()).toEqual(['Spikonado', 'OpenAI API', 'ChatGPT Subscription']);

	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Move ChatGPT Subscription up' }));
	});

	expect(providerNames()).toEqual(['Spikonado', 'ChatGPT Subscription', 'OpenAI API']);
	expect(mutation).toHaveBeenCalledWith(
		expect.anything(),
		{
			providerOrder: [
				{ provider: 'spikonado', enabled: true },
				{ provider: 'chatgpt', enabled: true },
				{ provider: 'openai', enabled: true }
			]
		},
		expect.anything()
	);
});

it('keeps the last enabled provider on and links unset providers to BYOK/BYOS', async () => {
	const onOpenCredentials = vi.fn();
	await mount(
		{
			...preferences,
			providerOrder: [
				{ provider: 'openai', enabled: true },
				{ provider: 'spikonado', enabled: false },
				{ provider: 'chatgpt', enabled: false }
			]
		},
		onOpenCredentials
	);

	expect(screen.getByRole('switch', { name: 'OpenAI API' })).toHaveProperty('disabled', true);
	expect(screen.getByRole('switch', { name: 'Spikonado' })).toHaveProperty('disabled', false);
	fireEvent.click(screen.getByRole('button', { name: 'Set up in BYOK/BYOS' }));
	expect(onOpenCredentials).toHaveBeenCalledOnce();
	expect(
		screen.getByRole('switch', { name: "Restrict subagents to the parent's provider" })
	).toHaveProperty('ariaChecked', 'false');
});
