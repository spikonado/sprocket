import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { initConvexTest, type ConvexTestInstance } from './test.setup';

const WEBHOOK_SECRET = 'test_webhook_secret';

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function billingFixture() {
	vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
	vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
	vi.stubEnv('DODO_PAYMENTS_WEBHOOK_SECRET', btoa(WEBHOOK_SECRET));
	const t = initConvexTest();
	await t.run(async (ctx) => {
		await ctx.db.insert('tiers', {
			tierId: 'pro',
			label: 'Pro',
			weekly: 1,
			monthly: 1,
			monthlyProductId: 'prod_monthly',
			annualProductId: 'prod_annual'
		});
		await ctx.db.insert('tiers', { tierId: 'free', label: 'Free', weekly: 1, monthly: 1 });
	});
	const requests: Request[] = [];
	vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		requests.push(request.clone());
		const path = new URL(request.url).pathname;

		if (path === '/customers') return Response.json({ customer_id: 'cus_owner' });

		if (path.startsWith('/products/')) {
			return Response.json({
				product_id: path.split('/').at(-1),
				name: 'Pro',
				price: {
					type: 'recurring_price',
					price: 2_000,
					currency: 'USD',
					payment_frequency_count: 1,
					payment_frequency_interval: path.endsWith('prod_annual') ? 'Year' : 'Month'
				}
			});
		}

		if (path === '/checkouts') {
			const body = await request.json();

			return Response.json({
				checkout_url: `https://checkout.example/${body.product_cart[0].product_id}`
			});
		}

		throw new Error(`Unexpected Dodo request: ${path}`);
	});

	return { t, requests, owner: t.withIdentity({ subject: 'owner', email: 'owner@example.com' }) };
}

async function subscriptionActiveWebhook(
	t: ConvexTestInstance,
	args: {
		subscriptionId: string;
		productId: string;
		interval: 'Month' | 'Year';
		userId: string;
		tierId: string;
		checkoutAttemptId: string;
		eventAt: number;
		periodStart: number;
		periodEnd: number;
	}
) {
	const body = JSON.stringify({
		business_id: 'business',
		type: 'subscription.active',
		timestamp: new Date(args.eventAt).toISOString(),
		data: {
			payload_type: 'Subscription',
			addons: [],
			billing: { city: null, country: 'US', state: null, street: null, zipcode: null },
			brand_id: 'brand',
			cancel_at_next_billing_date: false,
			created_at: new Date(args.periodStart).toISOString(),
			credit_entitlement_cart: [],
			currency: 'USD',
			customer: { customer_id: 'cus_owner', email: 'owner@example.com', name: 'Owner' },
			metadata: {
				userId: args.userId,
				tierId: args.tierId,
				checkoutAttemptId: args.checkoutAttemptId
			},
			meter_credit_entitlement_cart: [],
			meters: [],
			next_billing_date: new Date(args.periodEnd).toISOString(),
			on_demand: false,
			payment_frequency_count: 1,
			payment_frequency_interval: args.interval,
			previous_billing_date: new Date(args.periodStart).toISOString(),
			product_id: args.productId,
			quantity: 1,
			recurring_pre_tax_amount: 2_000,
			status: 'active',
			subscription_id: args.subscriptionId,
			subscription_period_count: 1,
			subscription_period_interval: args.interval,
			tax_inclusive: false,
			trial_period_days: 0
		}
	});

	const webhookId = `webhook_${args.subscriptionId}`;
	const timestamp = String(Math.floor(args.eventAt / 1_000));
	const encoder = new TextEncoder();

	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(WEBHOOK_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(`${webhookId}.${timestamp}.${body}`)
	);

	return await t.fetch('/dodopayments-webhook', {
		method: 'POST',
		body,
		headers: {
			'webhook-id': webhookId,
			'webhook-timestamp': timestamp,
			'webhook-signature': `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
		}
	});
}

describe('checkout selection changes', () => {
	it('opens a different interval immediately on the same saved customer and reuses matching retries', async () => {
		const { t, owner, requests } = await billingFixture();
		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).resolves.toEqual({ checkout_url: 'https://checkout.example/prod_monthly' });
		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' })
		).resolves.toEqual({ checkout_url: 'https://checkout.example/prod_annual' });
		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' });

		const customerRequests = requests.filter(
			(request) => new URL(request.url).pathname === '/customers'
		);

		expect(customerRequests).toHaveLength(1);
		expect(customerRequests[0]!.headers.get('Idempotency-Key')).toBe('sprocket-customer:owner');
		const checkouts = requests.filter((request) => new URL(request.url).pathname === '/checkouts');
		expect(checkouts).toHaveLength(2);

		for (const request of checkouts) {
			expect(await request.json()).toMatchObject({
				customer: { customer_id: 'cus_owner' },
				feature_flags: { always_create_new_customer: false, allow_customer_editing_email: false }
			});
		}

		expect(checkouts[0]!.headers.get('Idempotency-Key')).not.toBe(
			checkouts[1]!.headers.get('Idempotency-Key')
		);
		await expect(
			t.query(internal.billingCustomers.get, { userId: 'owner' })
		).resolves.toMatchObject({ dodoCustomerId: 'cus_owner' });
	});

	it('retains the saved customer across concurrent creation results', async () => {
		const { t, requests } = await billingFixture();
		await Promise.all([
			t.action(internal.pricing.ensureCustomer, {
				userId: 'owner',
				email: 'owner@example.com',
				name: 'Owner'
			}),
			t.action(internal.pricing.ensureCustomer, {
				userId: 'owner',
				email: 'owner@example.com',
				name: 'Owner'
			})
		]);
		await expect(
			t.mutation(internal.billingCustomers.remember, {
				userId: 'owner',
				dodoCustomerId: 'cus_late'
			})
		).resolves.toBe('cus_owner');
		const keys = requests.map((request) => request.headers.get('Idempotency-Key'));
		expect(keys.every((key) => key === 'sprocket-customer:owner')).toBe(true);
		await expect(
			t.action(internal.pricing.ensureCustomer, { userId: 'owner', name: 'Owner' })
		).resolves.toBe('cus_owner');
	});

	it('honors an older checkout that is paid after the customer selects a different interval', async () => {
		const { t, owner } = await billingFixture();
		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });

		const monthly = await t.run(async (ctx) => ctx.db.query('billingCheckoutSessions').unique());

		if (!monthly) throw new Error('Missing monthly checkout reservation.');

		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' });

		const now = Date.now();

		const response = await subscriptionActiveWebhook(t, {
			subscriptionId: 'sub_monthly',
			productId: 'prod_monthly',
			interval: 'Month',
			userId: 'owner',
			tierId: 'pro',
			checkoutAttemptId: monthly.attemptId,
			eventAt: now,
			periodStart: now,
			periodEnd: now + 30 * 86_400_000
		});

		expect(response.status).toBe(200);

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		expect(stored).toMatchObject({
			tier: 'pro',
			status: 'active',
			eventAt: now,
			billingInterval: 'monthly',
			dodoSubscriptionId: 'sub_monthly',
			dodoProductId: 'prod_monthly'
		});
		await expect(owner.query(api.billing.getMySubscription, {})).resolves.toMatchObject({
			tier: 'pro',
			billingManaged: true
		});
		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' })
		).rejects.toThrow('A paid plan is already active');
	});

	it('keeps the current annual reservation when a late monthly attach is rejected', async () => {
		const { t, owner } = await billingFixture();
		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });

		const monthly = await t.run(async (ctx) => ctx.db.query('billingCheckoutSessions').unique());

		if (!monthly) throw new Error('Missing monthly checkout reservation.');

		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' });

		const annual = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		if (!annual) throw new Error('Missing annual checkout reservation.');

		await expect(
			t.mutation(internal.billing.attachCheckoutSession, {
				userId: 'owner',
				attemptId: monthly.attemptId,
				checkoutUrl: 'https://checkout.example/prod_monthly'
			})
		).rejects.toThrow('Checkout reservation expired.');

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		expect(stored).toMatchObject({
			attemptId: annual.attemptId,
			tierId: 'pro',
			interval: 'annual',
			productId: 'prod_annual',
			expiresAt: annual.expiresAt,
			checkoutUrl: 'https://checkout.example/prod_annual'
		});
	});
});
