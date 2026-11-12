import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider, fixtureId } from '$lib/convex-test-client';
import SettingsPayments from './settings-payments';

const threadId = fixtureId<'threadRecords'>('thread-test');

const purchaseId = fixtureId<'purchases'>('purchase-test');

afterEach(() => vi.restoreAllMocks());

async function mount(client: ConvexTestClient, onOpenThread = vi.fn(async () => {})) {
	client.handleAction(api.payments.listMyCards, async () => [
		{ id: 'card', brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2030 }
	]);
	client.registerQuery(api.payments.listMyPurchases, [
		{
			_id: purchaseId,
			threadId,
			merchant: 'shop.example.com',
			amount: 2306,
			currency: 'usd',
			status: 'settled',
			orderNumber: '112-7',
			orderLink: 'https://shop.example.com/orders/112-7',
			trackingLink: 'https://track.example.com/1Z',
			createdAt: Date.UTC(2026, 0, 2)
		}
	]);
	await act(async () => {
		render(
			<ConvexTestProvider client={client}>
				<SettingsPayments onOpenThread={onOpenThread} />
			</ConvexTestProvider>
		);
	});
}

it('lists saved cards and purchases and opens a purchase thread', async () => {
	const onOpenThread = vi.fn(async () => {});
	await mount(new ConvexTestClient(), onOpenThread);
	expect(await screen.findByText('•••• 4242')).toBeTruthy();
	expect(screen.getByText('visa')).toBeTruthy();
	expect(screen.getByText('Expires 04/30')).toBeTruthy();
	expect(screen.getByText('$23.06')).toBeTruthy();
	expect(screen.getByRole('link', { name: 'Order 112-7' }).getAttribute('href')).toBe(
		'https://shop.example.com/orders/112-7'
	);
	expect(screen.getByRole('link', { name: 'Track order' }).getAttribute('href')).toBe(
		'https://track.example.com/1Z'
	);
	fireEvent.click(screen.getByRole('button', { name: 'View thread' }));
	expect(onOpenThread).toHaveBeenCalledWith(threadId);
});

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

it('offers the Agentcard link as a QR code and a popup on this computer', async () => {
	const open = vi.spyOn(window, 'open').mockReturnValue(null);
	const client = new ConvexTestClient();
	client.handleAction(api.payments.createCardLink, async () => ({ url: 'https://vault.test' }));
	await mount(client);
	fireEvent.click(screen.getByRole('button', { name: 'Add a card' }));
	expect(await screen.findByRole('img', { name: 'QR code for the Agentcard link' })).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'Open on this computer' }));
	expect(open).toHaveBeenCalledWith(
		'https://vault.test',
		'agentcard',
		'popup,width=480,height=760'
	);
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
