import { afterEach, describe, expect, it, vi } from 'vitest';
import { initConvexTest } from './test.setup';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('Dodo status webhooks', () => {
	it.each(['remapped', 'removed', 'ambiguous'])(
		'keeps the stored tier on hold after its product assignment is %s',
		async (assignment) => {
			const t = initConvexTest();
			const now = Date.now();
			const secret = 'test_webhook_secret';
			vi.stubEnv('DODO_PAYMENTS_WEBHOOK_SECRET', btoa(secret));
			await t.run(async (ctx) => {
				await ctx.db.insert('subscriptions', {
					userId: 'user_team',
					tier: 'team',
					status: 'active',
					eventAt: now - 1_000,
					dodoSubscriptionId: 'sub_team',
					dodoProductId: 'prod_team'
				});

				if (assignment !== 'removed') {
					await ctx.db.insert('tiers', {
						tierId: 'max',
						label: 'Max',
						weekly: 1,
						monthly: 1,
						monthlyProductId: 'prod_team',
						annualProductId: assignment === 'ambiguous' ? 'prod_team' : undefined
					});
				}
			});

			const body = JSON.stringify({
				business_id: 'business',
				type: 'subscription.updated',
				timestamp: new Date(now).toISOString(),
				data: {
					payload_type: 'Subscription',
					addons: [],
					billing: { city: null, country: 'US', state: null, street: null, zipcode: null },
					brand_id: 'brand',
					cancel_at_next_billing_date: false,
					created_at: new Date(now - 60_000).toISOString(),
					credit_entitlement_cart: [],
					currency: 'USD',
					customer: { customer_id: 'cus_team', email: 'team@example.com', name: 'Team' },
					metadata: { userId: 'user_team', tierId: 'team' },
					meter_credit_entitlement_cart: [],
					meters: [],
					next_billing_date: new Date(now + 60_000).toISOString(),
					on_demand: false,
					payment_frequency_count: 1,
					payment_frequency_interval: 'Month',
					previous_billing_date: new Date(now - 60_000).toISOString(),
					product_id: 'prod_team',
					quantity: 1,
					recurring_pre_tax_amount: 2_000,
					status: 'on_hold',
					subscription_id: 'sub_team',
					subscription_period_count: 1,
					subscription_period_interval: 'Month',
					tax_inclusive: false,
					trial_period_days: 0
				}
			});

			const webhookId = 'webhook_hold';
			const timestamp = String(Math.floor(now / 1_000));
			const encoder = new TextEncoder();

			const key = await crypto.subtle.importKey(
				'raw',
				encoder.encode(secret),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign']
			);

			const signature = await crypto.subtle.sign(
				'HMAC',
				key,
				encoder.encode(`${webhookId}.${timestamp}.${body}`)
			);

			const response = await t.fetch('/dodopayments-webhook', {
				method: 'POST',
				body,
				headers: {
					'webhook-id': webhookId,
					'webhook-timestamp': timestamp,
					'webhook-signature': `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
				}
			});

			expect(response.status).toBe(200);

			const stored = await t.run(async (ctx) =>
				ctx.db
					.query('subscriptions')
					.withIndex('by_userId', (query) => query.eq('userId', 'user_team'))
					.unique()
			);

			expect(stored).toMatchObject({ tier: 'team', status: 'on_hold', eventAt: now });
		}
	);
});
