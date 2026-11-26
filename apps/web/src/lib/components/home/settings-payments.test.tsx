import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import SettingsPayments from './settings-payments';

afterEach(() => vi.restoreAllMocks());

async function mount(client: ConvexTestClient) {
	client.handleAction(api.payments.listMyCards, async () => [
		{ id: 'card', brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2030 }
	]);
	client.registerQuery(api.payments.listMyPurchases, []);
	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<SettingsPayments onOpenThread={vi.fn(async () => {})} />
			</ConvexTestProvider>
		);
	});
}

it('keeps the newest card list when an older reload finishes last', async () => {
	const client = new ConvexTestClient();
	await mount(client);
	await screen.findByText('•••• 4242');

	let resolveSlow: (cards: []) => void = () => {};

	client.handleAction(
		api.payments.listMyCards,
		() => new Promise((resolve) => (resolveSlow = resolve))
	);
	fireEvent.focus(window);
	client.handleAction(api.payments.listMyCards, async () => [
		{ id: 'new', brand: 'visa', last4: '1111', expiryMonth: 1, expiryYear: 2031 }
	]);
	fireEvent.focus(window);
	expect(await screen.findByText('•••• 1111')).toBeTruthy();

	await act(async () => resolveSlow([]));
	expect(screen.getByText('•••• 1111')).toBeTruthy();
});

it('offers the Agentcard link and shows the new card once the dialog closes', async () => {
	const client = new ConvexTestClient();
	client.handleAction(api.payments.createCardLink, async () => ({ url: 'https://vault.test' }));
	await mount(client);
	await screen.findByText('•••• 4242');
	fireEvent.click(screen.getByRole('button', { name: 'Add a card' }));
	expect(await screen.findByRole('img', { name: 'QR code for the Agentcard link' })).toBeTruthy();
	expect(screen.getByRole('link', { name: 'Open on this computer' }).getAttribute('href')).toBe(
		'https://vault.test'
	);
	client.handleAction(api.payments.listMyCards, async () => [
		{ id: 'new', brand: 'visa', last4: '1111', expiryMonth: 1, expiryYear: 2031 }
	]);
	fireEvent.click(screen.getByRole('button', { name: 'Done' }));
	expect(await screen.findByText('•••• 1111')).toBeTruthy();
});

it('shows why the card link could not be created', async () => {
	const client = new ConvexTestClient();
	client.handleAction(api.payments.createCardLink, async () => {
		throw new Error('Agentcard is down.');
	});
	await mount(client);
	fireEvent.click(screen.getByRole('button', { name: 'Add a card' }));
	expect(await screen.findByText('Agentcard is down.')).toBeTruthy();
});
