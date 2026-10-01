import { defineSchema } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('billing portal recovery', () => {
	it.each(['on_hold', 'failed', 'cancelled', 'expired'] as const)(
		"opens the account owner's portal while a subscription is %s without restoring paid access",
		async (status) => {
			vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
			vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
			const requests: string[] = [];
			vi.stubGlobal('fetch', async (request: Request | string | URL) => {
				const url = request instanceof Request ? request.url : String(request);
				requests.push(url);

				return Response.json({ link: 'https://customer.dodopayments.com/owner-portal' });
			});
			const t = initConvexTest();
			t.registerComponent(
				'dodopayments',
				defineSchema({}),
				import.meta.glob('../node_modules/@dodopayments/convex/dist/component/**/*.js')
			);
			await t.run(async (ctx) => {
				await ctx.db.insert('tiers', { tierId: 'free', label: 'Free', weekly: 1, monthly: 1 });
				await ctx.db.insert('subscriptions', {
					userId: 'owner',
					tier: 'pro',
					status,
					eventAt: Date.now(),
					dodoSubscriptionId: 'sub_owner'
				});
				await ctx.db.insert('billingCustomers', { userId: 'owner', dodoCustomerId: 'cus_owner' });
				await ctx.db.insert('billingCustomers', { userId: 'other', dodoCustomerId: 'cus_other' });
			});
			const owner = t.withIdentity({ subject: 'owner' });
			await expect(owner.query(api.billing.getMySubscription, {})).resolves.toEqual({
				tier: 'free',
				tierLabel: 'Free',
				billingManaged: true
			});
			await expect(owner.action(api.billing.customerPortal, {})).resolves.toEqual({
				portal_url: 'https://customer.dodopayments.com/owner-portal'
			});
			expect(requests).toHaveLength(1);
			expect(new URL(requests[0]!).pathname).toBe('/customers/cus_owner/customer-portal/session');
		}
	);

	it('keeps billing history reachable when no subscription row remains', async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', { tierId: 'free', label: 'Free', weekly: 1, monthly: 1 });
			await ctx.db.insert('billingCustomers', { userId: 'owner', dodoCustomerId: 'cus_owner' });
		});
		await expect(
			t.withIdentity({ subject: 'owner' }).query(api.billing.getMySubscription, {})
		).resolves.toMatchObject({ tier: 'free', billingManaged: true });
	});
});
