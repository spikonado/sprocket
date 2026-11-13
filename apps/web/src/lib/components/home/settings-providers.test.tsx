import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { ProviderOrderEntry } from '@convex/lib/providerOrder';
import SettingsProviders from './settings-providers';

async function mount(
	providerOrder: ProviderOrderEntry[],
	onRemove = vi.fn(async (): Promise<string | null> => null)
) {
	const client = new ConvexTestClient();
	client.registerQuery(api.uiPreferences.getMyProviderOrder, providerOrder);
	client.registerMutation(api.uiPreferences.setProviderOrder, new Promise<null>(() => {}));
	const mutation = vi.spyOn(client, 'mutation');
	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<SettingsProviders onRemove={onRemove} onOpenCredentials={vi.fn()} />
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

it('lists the saved provider order and saves toggles', async () => {
	const order: ProviderOrderEntry[] = [
		{ provider: 'openai', enabled: true },
		{ provider: 'spikonado', enabled: true },
		{ provider: 'muse', enabled: false }
	];

	const mutation = await mount(order);
	expect(providerNames()).toEqual(['OpenAI API', 'Spikonado', 'Muse Code Subscription']);

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
	expect(screen.getByRole('switch', { name: 'OpenAI API' }).getAttribute('aria-checked')).toBe(
		'false'
	);
	expect(screen.getByRole('switch', { name: 'Spikonado' })).toHaveProperty('disabled', true);
});

it('removes a provider after confirmation, shows its warning, and keeps Spikonado and Muse', async () => {
	const onRemove = vi.fn(async (): Promise<string | null> => 'Revoke access at chatgpt.com.');
	await mount(
		[
			{ provider: 'spikonado', enabled: true },
			{ provider: 'chatgpt', enabled: true },
			{ provider: 'muse', enabled: true }
		],
		onRemove
	);

	expect(screen.queryByRole('button', { name: 'Remove Spikonado' })).toBeNull();
	expect(screen.queryByRole('button', { name: 'Remove Muse Code Subscription' })).toBeNull();
	fireEvent.click(screen.getByRole('button', { name: 'Remove ChatGPT Subscription' }));
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
	});

	expect(onRemove).toHaveBeenCalledWith('chatgpt');
	expect(screen.getByText('Revoke access at chatgpt.com.')).toBeTruthy();
});
