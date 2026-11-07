import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, insertUser } from './test.setup';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('billing portal recovery', () => {
	it.each(['on_hold', 'past_due', 'failed', 'cancelled', 'expired'] as const)(
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
			await t.run(async (ctx) => {
				await ctx.db.insert('tiers', { tierId: 'free', label: 'Free', monthly: 1 });
				await ctx.db.insert('tiers', {
					tierId: 'pro',
					label: 'Pro',
					monthly: 2,
					monthlyProductId: 'prod_pro'
				});
				await ctx.db.insert('subscriptions', {
					userId: 'owner',
					dodoSubscriptionId: 'sub_owner',
					dodoProductId: 'prod_pro',
					status,
					billingPeriodStart: Date.now() - 60_000,
					billingPeriodEnd: Date.now() + 60_000,
					cancelAtNextBillingDate: false,
					syncedAt: Date.now()
				});
				await insertUser(ctx, 'owner', 'cus_owner');
				await insertUser(ctx, 'other', 'cus_other');
			});
			const owner = t.withIdentity({ subject: 'owner' });
			await expect(owner.query(api.billing.getMySubscription, {})).resolves.toMatchObject({
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
			await ctx.db.insert('tiers', { tierId: 'free', label: 'Free', monthly: 1 });
			await insertUser(ctx, 'owner', 'cus_owner');
		});
		await expect(
			t.withIdentity({ subject: 'owner' }).query(api.billing.getMySubscription, {})
		).resolves.toMatchObject({ tier: 'free', billingManaged: true });
	});
});
