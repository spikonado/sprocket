import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { ProviderOrderEntry } from '@convex/lib/providerOrder';
import type { CompletionProvider } from '@convex/lib/validators';
import SettingsProviders from './settings-providers';

async function mount(
	providerOrder: ProviderOrderEntry[],
	onOpenCredentials = vi.fn(),
	configuredProviders: CompletionProvider[] = ['spikonado', 'openai', 'chatgpt', 'claude']
) {
	const client = new ConvexTestClient();
	client.registerQuery(api.uiPreferences.getMyProviderOrder, providerOrder);
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
	const order: ProviderOrderEntry[] = [
		{ provider: 'spikonado', enabled: true },
		{ provider: 'openai', enabled: true },
		{ provider: 'muse', enabled: false },
		{ provider: 'chatgpt', enabled: false },
		{ provider: 'claude', enabled: true }
	];

	const mutation = await mount(order);
	expect(providerNames()).toEqual([
		'Spikonado',
		'OpenAI API',
		'ChatGPT Subscription',
		'Claude Subscription'
	]);

	await act(async () => {
		fireEvent.click(screen.getByRole('switch', { name: 'OpenAI API' }));
	});

	expect(mutation).toHaveBeenCalledWith(
		expect.anything(),
		{
			providerOrder: order.map((entry) =>
				entry.provider === 'openai' ? { ...entry, enabled: false } : entry
			)
		},
		expect.anything()
	);
});

it('hides unconfigured providers and keeps the last shown provider on', async () => {
	const onOpenCredentials = vi.fn();
	await mount(
		[
			{ provider: 'openai', enabled: true },
			{ provider: 'spikonado', enabled: false },
			{ provider: 'chatgpt', enabled: true }
		],
		onOpenCredentials,
		['spikonado', 'openai']
	);

	expect(providerNames()).toEqual(['OpenAI API', 'Spikonado']);
	expect(screen.getByRole('switch', { name: 'OpenAI API' })).toHaveProperty('disabled', true);
	expect(screen.getByRole('switch', { name: 'Spikonado' })).toHaveProperty('disabled', false);
	fireEvent.click(screen.getByRole('button', { name: 'Set up more providers in BYOK/BYOS' }));
	expect(onOpenCredentials).toHaveBeenCalledOnce();
});
