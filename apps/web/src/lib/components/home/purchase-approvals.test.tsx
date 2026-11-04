import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
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

it('opens the Agentcard approval popup', () => {
	const open = vi.spyOn(window, 'open').mockReturnValue(null);
	render(<PurchaseApprovals purchases={[purchase('a')]} />);
	expect(screen.getByText('Approve $23.06 at shop.example.com')).toBeTruthy();
	fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
	expect(open).toHaveBeenCalledWith(
		'https://approve.test/a',
		'agentcard',
		'popup,width=480,height=760'
	);
	open.mockRestore();
});
