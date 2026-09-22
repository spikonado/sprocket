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
import { resolveSubscriptionTier } from '@convex/lib/dodoSubscription';
import { resolveMarketingPricingUrls } from '@convex/lib/marketingOrigin';
import { initConvexTest } from './test.setup';

const ENV_KEYS = [
	'DODO_PAYMENTS_API_KEY',
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

	it('maps products for an arbitrary configured tier', async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				weekly: 1,
				monthly: 1,
				monthlyProductId: 'prod_team_monthly',
				annualProductId: 'prod_team_annual'
			});
		});

		await expect(
			t.query(internal.pricingData.getTierProduct, { tierId: 'team', interval: 'monthly' })
		).resolves.toBe('prod_team_monthly');
		await expect(
			t.query(internal.pricingData.getTierForProduct, { productId: 'prod_team_annual' })
		).resolves.toBe('team');
	});

	it('rejects a product assigned to more than one tier or interval', async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				weekly: 1,
				monthly: 1,
				monthlyProductId: 'prod_shared'
			});
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				weekly: 1,
				monthly: 1,
				annualProductId: 'prod_shared'
			});
		});

		await expect(
			t.query(internal.pricingData.getTierForProduct, { productId: 'prod_shared' })
		).rejects.toThrow('Dodo product "prod_shared" is assigned more than once.');
		await expect(
			t.query(internal.pricingData.getTierProduct, { tierId: 'team', interval: 'annual' })
		).rejects.toThrow('Dodo product "prod_shared" is assigned more than once.');
	});

	it('accepts checkout for an arbitrary tier with a configured product', async () => {
		delete process.env.DODO_PAYMENTS_API_KEY;
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				weekly: 1,
				monthly: 1,
				monthlyProductId: 'prod_team_monthly'
			});
		});

		await expect(
			t
				.withIdentity({ subject: 'user_team', email: 'team@example.com' })
				.action(api.billing.checkout, {
					tier: 'team',
					interval: 'monthly'
				})
		).rejects.toThrow('Payments are not configured.');
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
		expect(resolveMarketingPricingUrls({}, 'team/plus')).toEqual({
			return_url: 'https://spikonado.com/pricing?checkout=return&tier=team%2Fplus',
			cancel_url: 'https://spikonado.com/pricing?checkout=cancel&tier=team%2Fplus'
		});
	});
});

describe('Dodo subscription persistence', () => {
	it('reuses a matching checkout reservation and rejects plan changes until expiry', async () => {
		const t = initConvexTest();
		const first = await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_checkout',
			attemptId: 'attempt_1',
			tierId: 'pro',
			interval: 'monthly',
			productId: 'prod_monthly',
			now: 1_000
		});
		expect(first).toEqual({
			kind: 'create',
			attemptId: 'attempt_1',
			interval: 'monthly',
			productId: 'prod_monthly'
		});

		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_checkout',
				attemptId: 'attempt_2',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				now: 2_000
			})
		).resolves.toEqual(first);
		await expect(
			t.query(internal.billing.getCheckoutTier, {
				userId: 'user_checkout',
				attemptId: 'attempt_1',
				productId: 'prod_monthly'
			})
		).resolves.toBe('pro');
		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_checkout',
				attemptId: 'attempt_team',
				tierId: 'team',
				interval: 'monthly',
				productId: 'prod_monthly',
				now: 2_000
			})
		).rejects.toThrow('A monthly checkout is still active.');
		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_checkout',
				attemptId: 'attempt_3',
				tierId: 'pro',
				interval: 'annual',
				productId: 'prod_annual',
				now: 2_000
			})
		).rejects.toThrow('A monthly checkout is still active.');

		await t.mutation(internal.billing.attachCheckoutSession, {
			userId: 'user_checkout',
			attemptId: 'attempt_1',
			checkoutUrl: 'https://checkout.example/session_1'
		});
		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_checkout',
				attemptId: 'attempt_4',
				tierId: 'pro',
				interval: 'annual',
				productId: 'prod_annual',
				now: 3_000
			})
		).rejects.toThrow('A monthly checkout is still active.');

		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_checkout',
				attemptId: 'attempt_5',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				now: 4_000
			})
		).resolves.toEqual({
			kind: 'existing',
			checkoutUrl: 'https://checkout.example/session_1'
		});
	});

	it('backfills the tier on a matching legacy checkout reservation', async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutSessions', {
				userId: 'user_legacy',
				attemptId: 'attempt_legacy',
				interval: 'monthly',
				productId: 'prod_team_monthly',
				expiresAt: 10_000
			});
		});

		await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_legacy',
			attemptId: 'attempt_retry',
			tierId: 'team',
			interval: 'monthly',
			productId: 'prod_team_monthly',
			now: 2_000
		});

		await expect(
			t.query(internal.billing.getCheckoutTier, {
				userId: 'user_legacy',
				attemptId: 'attempt_legacy',
				productId: 'prod_team_monthly'
			})
		).resolves.toBe('team');
		await expect(
			t.query(internal.billing.getCheckoutTier, {
				userId: 'user_legacy',
				attemptId: 'another_attempt',
				productId: 'prod_team_monthly'
			})
		).resolves.toBeNull();
	});

	it('replaces an expired checkout reservation', async () => {
		const t = initConvexTest();
		await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_checkout',
			attemptId: 'attempt_1',
			tierId: 'pro',
			interval: 'monthly',
			productId: 'prod_monthly',
			now: 1_000
		});
		await t.run(async (ctx) => {
			const reservation = await ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', 'user_checkout'))
				.unique();
			if (!reservation) throw new Error('Missing checkout reservation.');
			await ctx.db.patch(reservation._id, { expiresAt: 1_999 });
		});

		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_checkout',
				attemptId: 'attempt_2',
				tierId: 'pro',
				interval: 'annual',
				productId: 'prod_annual',
				now: 2_000
			})
		).resolves.toEqual({
			kind: 'create',
			attemptId: 'attempt_2',
			interval: 'annual',
			productId: 'prod_annual'
		});
	});

	it('rejects a checkout reservation when a paid tier is active', async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId: 'user_pro',
				tier: 'pro',
				status: 'active',
				eventAt: 1_000
			});
		});

		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_pro',
				attemptId: 'attempt_1',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				now: 2_000
			})
		).rejects.toThrow('A paid plan is already active on this account.');
	});

	it('activates an arbitrary Dodo tier, links the customer, and ignores an older cancellation', async () => {
		const t = initConvexTest();
		await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_1',
			attemptId: 'attempt_1',
			tierId: 'team',
			interval: 'monthly',
			productId: 'prod_monthly',
			now: 1_000
		});
		const args = {
			userId: 'user_1',
			tier: 'team',
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
		expect(stored.subscription).toMatchObject({ tier: 'team', status: 'active', eventAt: 2_000 });
		expect(stored.customer).toMatchObject({ dodoCustomerId: 'cus_1' });
		const checkoutSession = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', args.userId))
				.unique()
		);
		expect(checkoutSession).toBeNull();

		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', { tierId: 'team', label: 'Team', weekly: 1, monthly: 1 });
		});
		await expect(
			t.withIdentity({ subject: args.userId }).query(api.billing.getMySubscription, {})
		).resolves.toMatchObject({ tier: 'team', tierLabel: 'Team', billingManaged: true });
		await expect(
			t.query(internal.billing.getDodoSubscriptionTier, {
				userId: args.userId,
				dodoSubscriptionId: args.dodoSubscriptionId
			})
		).resolves.toBe('team');
		await expect(
			t.query(internal.billingCustomers.getManageable, { userId: args.userId })
		).resolves.toMatchObject({ dodoCustomerId: 'cus_1' });
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

describe('Dodo subscription tier resolution', () => {
	it('keeps the purchase-time tier after a product is remapped', () => {
		expect(
			resolveSubscriptionTier({
				checkoutTier: 'team',
				metadataTier: 'team',
				existingTier: null,
				configuredTier: 'max',
				legacyTier: undefined
			})
		).toBe('team');
		expect(
			resolveSubscriptionTier({
				checkoutTier: null,
				metadataTier: undefined,
				existingTier: 'team',
				configuredTier: 'max',
				legacyTier: undefined
			})
		).toBe('team');
	});

	it('rejects conflicting checkout and signed metadata tiers', () => {
		expect(() =>
			resolveSubscriptionTier({
				checkoutTier: 'team',
				metadataTier: 'max',
				existingTier: null,
				configuredTier: 'max',
				legacyTier: undefined
			})
		).toThrow('Dodo subscription tier metadata does not match its checkout reservation.');
	});

	it('uses the current product tier for an explicit Dodo plan change', () => {
		expect(
			resolveSubscriptionTier({
				checkoutTier: null,
				metadataTier: 'team',
				existingTier: 'team',
				configuredTier: 'max',
				legacyTier: undefined,
				preferConfiguredTier: true
			})
		).toBe('max');
	});
});
