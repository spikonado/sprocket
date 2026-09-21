import { afterEach, describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import {
	productIdForCheckout,
	readProProductIds,
	matchesBillingInterval,
	readDodoEnvironment,
	tierForProductId,
	type ProProductIds
} from '@convex/lib/dodoProducts';
import { resolveMarketingPricingUrls } from '@convex/lib/marketingOrigin';
import { initConvexTest } from './test.setup';

const ENV_KEYS = [
	'DODO_PAYMENTS_PRO_MONTHLY_PRODUCT_ID',
	'DODO_PAYMENTS_PRO_ANNUAL_PRODUCT_ID'
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const products: ProProductIds = { monthly: 'prod_monthly', annual: 'prod_annual' };

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe('Dodo product mapping', () => {
	it('reads product ids and maps only the configured Pro products', () => {
		process.env.DODO_PAYMENTS_PRO_MONTHLY_PRODUCT_ID = ' prod_monthly ';
		process.env.DODO_PAYMENTS_PRO_ANNUAL_PRODUCT_ID = 'prod_annual';
		expect(readProProductIds()).toEqual(products);
		expect(productIdForCheckout('pro', 'monthly', products)).toBe('prod_monthly');
		expect(productIdForCheckout('free', 'monthly', products)).toBeUndefined();
		expect(tierForProductId('prod_annual', products)).toBe('pro');
		expect(tierForProductId('other', products)).toBeUndefined();
	});

	it('accepts only monthly and annual recurring schedules for their mapped products', () => {
		expect(matchesBillingInterval('monthly', 1, 'Month')).toBe(true);
		expect(matchesBillingInterval('monthly', 1, 'Year')).toBe(false);
		expect(matchesBillingInterval('annual', 1, 'Year')).toBe(true);
		expect(matchesBillingInterval('annual', 12, 'Month')).toBe(true);
		expect(matchesBillingInterval('annual', 1, 'Month')).toBe(false);
	});

	it('rejects unknown Dodo environments', () => {
		expect(readDodoEnvironment({})).toBe('test_mode');
		expect(readDodoEnvironment({ DODO_PAYMENTS_ENVIRONMENT: 'live_mode' })).toBe('live_mode');
		expect(() => readDodoEnvironment({ DODO_PAYMENTS_ENVIRONMENT: 'production' })).toThrow(
			'DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode.'
		);
	});
});

describe('marketing checkout URLs', () => {
	it('allows the production site and test-mode localhost only', () => {
		expect(resolveMarketingPricingUrls({})).toEqual({
			return_url: 'https://spikonado.com/pricing?checkout=return',
			cancel_url: 'https://spikonado.com/pricing?checkout=cancel'
		});
		expect(
			resolveMarketingPricingUrls({
				SPROCKET_MARKETING_ORIGIN: 'http://localhost:4321',
				DODO_PAYMENTS_ENVIRONMENT: 'test_mode'
			})
		).toEqual({
			return_url: 'http://localhost:4321/pricing?checkout=return',
			cancel_url: 'http://localhost:4321/pricing?checkout=cancel'
		});
		expect(
			resolveMarketingPricingUrls({
				SPROCKET_MARKETING_ORIGIN: 'http://localhost:4321',
				DODO_PAYMENTS_ENVIRONMENT: 'live_mode'
			})
		).toEqual({
			return_url: 'https://spikonado.com/pricing?checkout=return',
			cancel_url: 'https://spikonado.com/pricing?checkout=cancel'
		});
	});
});

describe('Dodo subscription persistence', () => {
	it('activates Pro, links the customer, and ignores an older cancellation', async () => {
		const t = initConvexTest();
		const args = {
			userId: 'user_1',
			tier: 'pro',
			dodoSubscriptionId: 'sub_1',
			dodoProductId: 'prod_monthly',
			dodoCustomerId: 'cus_1',
			status: 'active' as const,
			eventAt: 2_000
		};
		await t.mutation(internal.billing.upsertDodoSubscription, args);
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			status: 'cancelled',
			eventAt: 1_000
		});

		const stored = await t.run(async (ctx) => ({
			subscription: await ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', args.userId))
				.unique(),
			customer: await ctx.db
				.query('billingCustomers')
				.withIndex('by_userId', (query) => query.eq('userId', args.userId))
				.unique()
		}));
		expect(stored.subscription).toMatchObject({ tier: 'pro', status: 'active', eventAt: 2_000 });
		expect(stored.customer).toMatchObject({ dodoCustomerId: 'cus_1' });

		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', { tierId: 'pro', label: 'Pro', weekly: 1, monthly: 1 });
		});
		await expect(
			t.withIdentity({ subject: args.userId }).query(api.billing.getMySubscription, {})
		).resolves.toMatchObject({ tier: 'pro', billingManaged: true });
		await expect(
			t.query(internal.billing.getDodoSubscriptionTier, {
				userId: args.userId,
				dodoSubscriptionId: args.dodoSubscriptionId
			})
		).resolves.toBe('pro');
	});

	it('does not reactivate a lapsed subscription with the same event timestamp', async () => {
		const t = initConvexTest();
		const args = {
			userId: 'user_lapsed',
			tier: 'pro',
			dodoSubscriptionId: 'sub_lapsed',
			dodoProductId: 'prod_monthly',
			dodoCustomerId: 'cus_lapsed',
			status: 'cancelled' as const,
			eventAt: 2_000
		};
		await t.mutation(internal.billing.upsertDodoSubscription, args);
		await t.mutation(internal.billing.upsertDodoSubscription, { ...args, status: 'active' });

		const subscription = await t.run(async (ctx) =>
			ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', args.userId))
				.unique()
		);
		expect(subscription).toMatchObject({ status: 'cancelled', eventAt: 2_000 });
	});

	it('does not let Dodo replace an active operator-managed tier', async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId: 'user_max',
				tier: 'max',
				status: 'active',
				eventAt: 1
			});
		});
		await t.mutation(internal.billing.upsertDodoSubscription, {
			userId: 'user_max',
			tier: 'pro',
			dodoSubscriptionId: 'sub_1',
			dodoProductId: 'prod_monthly',
			dodoCustomerId: 'cus_1',
			status: 'active',
			eventAt: 2
		});
		const subscription = await t.run(async (ctx) =>
			ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', 'user_max'))
				.unique()
		);
		expect(subscription).toMatchObject({ tier: 'max', status: 'active' });
		const customer = await t.run(async (ctx) =>
			ctx.db
				.query('billingCustomers')
				.withIndex('by_userId', (query) => query.eq('userId', 'user_max'))
				.unique()
		);
		expect(customer).toBeNull();

		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', { tierId: 'max', label: 'Max', weekly: 1, monthly: 1 });
		});
		await expect(
			t.withIdentity({ subject: 'user_max' }).query(api.billing.getMySubscription, {})
		).resolves.toMatchObject({ tier: 'max', billingManaged: false });
	});
});
