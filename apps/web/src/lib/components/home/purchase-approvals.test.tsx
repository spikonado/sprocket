import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import PurchaseApprovals from './purchase-approvals';
import { fixtureId } from '$lib/convex-test-client';

function purchase(id: string) {
	return {
		_id: fixtureId<'purchases'>(id),
		threadId: fixtureId<'threadRecords'>('thread'),
		merchant: 'shop.example.com',
		amount: 2306,
		currency: 'usd',
		status: 'awaiting_approval' as const,
		approvalUrl: `https://approve.test/${id}`,
		createdAt: 0
	};
}

it('offers the approval link as a QR code and a link on this computer', () => {
	render(<PurchaseApprovals purchases={[purchase('a')]} />);
	expect(screen.getByText('Approve $23.06 at shop.example.com')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
	expect(screen.getByRole('img', { name: 'QR code for the Agentcard link' })).toBeTruthy();
	expect(screen.getByRole('link', { name: 'Open on this computer' }).getAttribute('href')).toBe(
		'https://approve.test/a'
	);
});
