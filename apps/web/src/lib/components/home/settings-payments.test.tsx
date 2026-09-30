import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '$convex/_generated/dataModel';
import { api } from '$convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import SettingsPayments from './settings-payments';

// SAFETY: this opaque id is used only by the in-memory action client.
const mandateId = 'mandate-test' as Id<'mandates'>;
const approval = {
	mandateId,
	approvalUrl: 'https://approval.test/mandate',
	expiresAt: '2099-01-01'
};

async function mount(client: ConvexTestClient) {
	let view!: ReturnType<typeof render>;
	await act(async () => {
		view = render(
			<ConvexTestProvider client={client}>
				<SettingsPayments />
			</ConvexTestProvider>
		);
	});
	return view;
}

function fillSetup() {
	fireEvent.change(screen.getByLabelText('Merchant name'), { target: { value: 'Parts shop' } });
	fireEvent.change(screen.getByLabelText('Amount cap'), { target: { value: '50.00' } });
	fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Robot parts' } });
}

it('submits any-merchant mandates as one-time and presents the passkey approval link', async () => {
	const client = new ConvexTestClient();
	client.handleAction(api.payments.listMyMandates, async () => ({ mandates: [] }));
	const setup = vi.fn(async () => approval);
	client.handleAction(api.payments.setupMyMandate, setup);
	await mount(client);
	fillSetup();
	fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'any' } });
	fireEvent.click(screen.getByRole('button', { name: 'Set up mandate' }));
	expect((await screen.findByRole('link', { name: 'Approve mandate' })).getAttribute('href')).toBe(
		approval.approvalUrl
	);
	expect(setup).toHaveBeenCalledWith({
		merchantName: undefined,
		merchantUrl: undefined,
		countryCode: undefined,
		amountCap: '50.00',
		currency: 'USD',
		frequency: 'one_time',
		scope: 'any',
		description: 'Robot parts'
	});
});

it('keeps a failed setup editable and retries with the entered values', async () => {
	const client = new ConvexTestClient();
	client.handleAction(api.payments.listMyMandates, async () => ({ mandates: [] }));
	const setup = vi
		.fn(async () => approval)
		.mockRejectedValueOnce(new Error('Approval service unavailable'));
	client.handleAction(api.payments.setupMyMandate, setup);
	await mount(client);
	fillSetup();
	fireEvent.click(screen.getByRole('button', { name: 'Set up mandate' }));
	expect(await screen.findByText('Approval service unavailable')).toBeTruthy();
	expect(screen.getByLabelText('Description')).toHaveProperty('value', 'Robot parts');
	fireEvent.click(screen.getByRole('button', { name: 'Set up mandate' }));
	expect(await screen.findByRole('link', { name: 'Approve mandate' })).toBeTruthy();
	expect(setup).toHaveBeenLastCalledWith(
		expect.objectContaining({ merchantName: 'Parts shop', frequency: 'monthly', scope: 'listed' })
	);
});

it('refreshes approved mandates on focus and removes the listener on unmount', async () => {
	const client = new ConvexTestClient();
	let approved = false;
	const list = vi.fn(async () => ({
		mandates: approved
			? [
					{
						mandateId,
						pravaMandateId: 'prava-test',
						status: 'active',
						description: 'Robot parts',
						approvedAmount: '50.00',
						currency: 'USD'
					}
				]
			: []
	}));
	client.handleAction(api.payments.listMyMandates, list);
	client.handleAction(api.payments.setupMyMandate, async () => approval);
	const view = await mount(client);
	fillSetup();
	await act(async () => {
		fireEvent.click(screen.getByRole('button', { name: 'Set up mandate' }));
	});
	expect(screen.getByRole('link', { name: 'Approve mandate' })).toBeTruthy();
	approved = true;
	await act(async () => {
		fireEvent.focus(window);
	});
	expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
	view.unmount();
	const calls = list.mock.calls.length;
	await act(async () => {
		fireEvent.focus(window);
	});
	expect(list).toHaveBeenCalledTimes(calls);
});

it('pauses, resumes, and cancels the selected mandate and refreshes its status', async () => {
	const client = new ConvexTestClient();
	let status: FunctionReturnType<typeof api.payments.setMyMandateLifecycle>['status'] = 'active';
	client.handleAction(api.payments.listMyMandates, async () => ({
		mandates: [
			{
				mandateId,
				pravaMandateId: 'prava-test',
				status,
				description: 'Robot parts',
				approvedAmount: '50.00',
				currency: 'USD'
			}
		]
	}));
	const lifecycle = vi.fn(
		async ({ action }: { action: 'pause' | 'resume' | 'cancel'; mandateId: Id<'mandates'> }) => {
			status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
			return {
				mandateId,
				status,
				amountCap: '50.00',
				currency: 'USD',
				frequency: 'monthly',
				scope: 'listed'
			} satisfies FunctionReturnType<typeof api.payments.setMyMandateLifecycle>;
		}
	);
	client.handleAction(api.payments.setMyMandateLifecycle, lifecycle);
	await mount(client);
	fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
	fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
	await screen.findByRole('button', { name: 'Pause' });
	fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	await waitFor(() => expect(screen.getByText('cancelled', { exact: false })).toBeTruthy());
	expect(lifecycle.mock.calls.map(([request]) => request)).toEqual([
		{ mandateId, action: 'pause' },
		{ mandateId, action: 'resume' },
		{ mandateId, action: 'cancel' }
	]);
});
