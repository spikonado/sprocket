import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { matchesBillingInterval, readDodoEnvironment } from '@convex/lib/dodoProducts';
import { LIVE_SUBSCRIPTION_CHECKOUT_ERROR } from './dodo';
import { initConvexTest, insertUser, seedTiers, type ConvexTestInstance } from './test.setup';

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

function stubDodo({
	subscriptionStatuses = [],
	session = { payment_id: null, payment_status: null }
}: {
	subscriptionStatuses?: string[];
	session?: { payment_id: string | null; payment_status: string | null } | null;
} = {}): Request[] {
	vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
	vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
	vi.stubEnv('DODO_PAYMENTS_WEBHOOK_SECRET', 'whsec_test');
	vi.stubEnv('SPROCKET_MARKETING_ORIGIN', 'https://spikonado.com/');
	const requests: Request[] = [];

	vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		requests.push(request.clone());
		const path = new URL(request.url).pathname;

		if (path === '/customers') return Response.json({ customer_id: 'cus_new' });

		if (path === '/subscriptions') {
			return Response.json({ items: subscriptionStatuses.map((status) => ({ status })) });
		}

		if (path === '/checkouts') {
			return Response.json({ session_id: 'cks_1', checkout_url: 'https://checkout.example/cks_1' });
		}

		if (path.startsWith('/checkouts/')) {
			return session
				? Response.json({ id: path.split('/').at(-1), created_at: new Date(), ...session })
				: Response.json({ message: 'Not found' }, { status: 404 });
		}

		throw new Error(`Unexpected Dodo request: ${path}`);
	});

	return requests;
}

function paths(requests: Request[]) {
	return requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
}

function owner(t: ConvexTestInstance) {
	return t.withIdentity({ subject: 'owner', email: 'owner@example.com' });
}

describe('Dodo product mapping', () => {
	it('accepts only monthly and annual recurring schedules for their mapped products', () => {
		expect(matchesBillingInterval('monthly', 1, 'Month')).toBe(true);
		expect(matchesBillingInterval('monthly', 1, 'Year')).toBe(false);
		expect(matchesBillingInterval('annual', 1, 'Year')).toBe(true);
		expect(matchesBillingInterval('annual', 12, 'Month')).toBe(true);
		expect(matchesBillingInterval('annual', 1, 'Month')).toBe(false);
	});

	it('rejects unknown Dodo environments', () => {
		expect(readDodoEnvironment({ DODO_PAYMENTS_ENVIRONMENT: 'live_mode' })).toBe('live_mode');
		expect(() => readDodoEnvironment({ DODO_PAYMENTS_ENVIRONMENT: 'production' })).toThrow(
			'DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode.'
		);
	});

	it('rejects a product assigned to more than one tier or interval', async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				monthly: 1,
				monthlyProductId: 'prod_shared'
			});
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				monthly: 1,
				annualProductId: 'prod_shared'
			});
		});

		await expect(
			t.query(internal.pricing.getTierProduct, { tierId: 'team', interval: 'annual' })
		).rejects.toThrow('Dodo product "prod_shared" is assigned more than once.');
	});
});

describe('checkout', () => {
	it('creates the customer and a session tagged with the user', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const requests = stubDodo();

		await expect(
			owner(t).action(api.billing.checkout, { tier: 'pro', interval: 'annual' })
		).resolves.toEqual({
			checkout_url: 'https://checkout.example/cks_1',
			mode: 'test',
			attemptId: 'cks_1'
		});

		expect(paths(requests)).toEqual(['POST /customers', 'POST /checkouts']);
		expect(await requests[1]?.json()).toMatchObject({
			product_cart: [{ product_id: 'prod_pro_annual', quantity: 1 }],
			metadata: { userId: 'owner' },
			customer: { customer_id: 'cus_new' },
			return_url: 'https://spikonado.com/pricing?checkout=return&tier=pro',
			cancel_url: 'https://spikonado.com/pricing?checkout=cancel&tier=pro'
		});
		await expect(
			t.query(internal.billingCustomers.getDodoCustomerId, { userId: 'owner' })
		).resolves.toBe('cus_new');
	});

	it.each([
		[['cancelled', 'paused'], false],
		[['cancelled', 'expired', 'failed'], true]
	])('with Dodo subscriptions %j, starts a session: %s', async (subscriptionStatuses, allowed) => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run((ctx) => insertUser(ctx, 'owner', 'cus_owner'));
		const requests = stubDodo({ subscriptionStatuses });
		const result = owner(t).action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });

		if (allowed) await expect(result).resolves.toMatchObject({ attemptId: 'cks_1' });
		else await expect(result).rejects.toThrow(LIVE_SUBSCRIPTION_CHECKOUT_ERROR);

		expect(new URL(requests[0]?.url ?? '').searchParams.get('customer_id')).toBe('cus_owner');
		expect(paths(requests).includes('POST /checkouts')).toBe(allowed);
	});

	it('refuses checkout before calling Dodo when payments are not configured', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const requests = stubDodo();
		vi.stubEnv('DODO_PAYMENTS_API_KEY', undefined);

		await expect(
			owner(t).action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).rejects.toThrow('Payments are not configured.');
		expect(requests).toEqual([]);
	});

	it('sells a credit pack to a subscriber without the live subscription check', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run(async (ctx) => {
			await insertUser(ctx, 'owner', 'cus_owner');
			await ctx.db.insert('creditPacks', {
				productId: 'prod_pack',
				units: 1,
				expiresAfter: { count: 3, unit: 'month' },
				price: { productId: 'prod_pack', amountMinor: 500, currency: 'USD' }
			});
			await ctx.db.insert('creditPacks', {
				productId: 'prod_unpriced',
				units: 1,
				expiresAfter: { count: 30, unit: 'day' }
			});
		});
		const requests = stubDodo({ subscriptionStatuses: ['active'] });

		for (const productId of ['prod_pro', 'prod_unpriced']) {
			await expect(owner(t).action(api.billing.buyCredits, { productId })).rejects.toThrow(
				'Unknown credit pack.'
			);
		}

		await expect(
			owner(t).action(api.billing.buyCredits, { productId: 'prod_pack' })
		).resolves.toMatchObject({ attemptId: 'cks_1' });

		expect(paths(requests)).toEqual(['POST /checkouts']);
		expect(await requests[0]?.json()).toMatchObject({
			product_cart: [{ product_id: 'prod_pack', quantity: 1 }],
			metadata: {
				userId: 'owner',
				creditUnits: '1',
				creditExpiresAfterCount: '3',
				creditExpiresAfterUnit: 'month'
			},
			customer: { customer_id: 'cus_owner' },
			return_url: 'https://spikonado.com/pricing?checkout=return&pack=prod_pack'
		});
	});
});

describe('getCheckoutStatus', () => {
	it.each([
		[{ payment_id: null, payment_status: null }, { status: 'awaiting_payment' }],
		[{ payment_id: 'pay_1', payment_status: 'processing' }, { status: 'pending' }],
		[{ payment_id: 'pay_1', payment_status: 'cancelled' }, { status: 'failed' }],
		[
			{ payment_id: 'pay_1', payment_status: 'succeeded' },
			{ status: 'succeeded', activated: false, creditsAdded: false }
		]
	])('maps Dodo session %j to %j', async (session, expected) => {
		const t = initConvexTest();
		await seedTiers(t);
		stubDodo({ session });

		await expect(
			owner(t).action(api.billing.getCheckoutStatus, { attemptId: 'cks_1' })
		).resolves.toEqual({ attemptId: 'cks_1', mode: 'test', ...expected });
	});

	it('reports activation once the mirror grants a paid plan, and credits once the payment is granted', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		stubDodo({ session: { payment_id: 'pay_1', payment_status: 'succeeded' } });
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId: 'owner',
				dodoSubscriptionId: 'sub_owner',
				dodoProductId: 'prod_pro',
				status: 'active',
				billingPeriodStart: Date.now() - 60_000,
				billingPeriodEnd: Date.now() + 60_000,
				cancelAtNextBillingDate: false,
				syncedAt: Date.now()
			});
			await ctx.db.insert('creditGrants', {
				userId: 'owner',
				paymentId: 'pay_1',
				productId: 'prod_pack',
				units: 1,
				used: 0,
				expiresAt: Date.now() + 60_000
			});
		});

		await expect(
			owner(t).action(api.billing.getCheckoutStatus, { attemptId: 'cks_1' })
		).resolves.toMatchObject({ status: 'succeeded', activated: true, creditsAdded: true });
	});

	it('rejects a session Dodo does not know', async () => {
		const t = initConvexTest();
		stubDodo({ session: null });

		await expect(
			owner(t).action(api.billing.getCheckoutStatus, { attemptId: 'legacy-attempt' })
		).rejects.toThrow('Unknown checkout attempt.');
	});
});
