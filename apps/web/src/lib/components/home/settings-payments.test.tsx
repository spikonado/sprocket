import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import SettingsPayments from './settings-payments';

// SAFETY: this opaque id is used only by the in-memory client.
const threadId = 'thread-test' as Id<'threadRecords'>;

// SAFETY: this opaque id is used only by the in-memory client.
const purchaseId = 'purchase-test' as Id<'purchases'>;

afterEach(() => vi.restoreAllMocks());

function stubPopup() {
	const popup = { location: { href: '' }, close: vi.fn() };
	const open = vi.spyOn(window, 'open').mockReturnValue(Object.assign(Object.create(null), popup));

	return { popup, open };
}

async function mount(client: ConvexTestClient, onOpenThread = vi.fn(async () => {})) {
	client.handleAction(api.payments.myPayments, async () => ({
		cards: [{ id: 'card', brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2030 }]
	}));
	client.registerQuery(api.payments.listMyPurchases, [
		{
			_id: purchaseId,
			threadId,
			merchant: 'shop.example.com',
			amount: 2306,
			currency: 'usd',
			status: 'settled',
			approvalUrl: 'https://approve.test',
			orderNumber: '112-7',
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
	expect(screen.getByText('Order 112-7')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'View thread' }));
	expect(onOpenThread).toHaveBeenCalledWith(threadId);
});

it('opens the card popup on click and points it at the Agentcard link', async () => {
	const { popup, open } = stubPopup();
	const client = new ConvexTestClient();
	client.handleAction(api.payments.createCardLink, async () => ({ url: 'https://vault.test' }));
	await mount(client);
	fireEvent.click(screen.getByRole('button', { name: 'Add a card' }));
	expect(open).toHaveBeenCalledWith('', 'agentcard', 'popup,width=480,height=760');
	await waitFor(() => expect(popup.location.href).toBe('https://vault.test'));
});

it('closes the card popup when the link cannot be created', async () => {
	const { popup } = stubPopup();
	const client = new ConvexTestClient();
	client.handleAction(api.payments.createCardLink, async () => {
		throw new Error('Agentcard is down.');
	});
	await mount(client);
	fireEvent.click(screen.getByRole('button', { name: 'Add a card' }));
	expect(await screen.findByText('Agentcard is down.')).toBeTruthy();
	expect(popup.close).toHaveBeenCalled();
});
