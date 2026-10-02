import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';
import { sendSubscriptionWebhook, subscriptionPayload } from './billingWebhook.test.setup';

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function billingFixture() {
	vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
	vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
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

		const response = await sendSubscriptionWebhook(
			t,
			'subscription.active',
			subscriptionPayload({
				subscription_id: 'sub_monthly',
				product_id: 'prod_monthly',
				metadata: { userId: 'owner', tierId: 'pro', checkoutAttemptId: monthly.attemptId },
				previous_billing_date: new Date(now),
				next_billing_date: new Date(now + 30 * 86_400_000)
			}),
			now
		);

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
