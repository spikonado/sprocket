import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { matchesBillingInterval, readDodoEnvironment } from '@convex/lib/dodoProducts';
import { resolveMarketingPricingUrls } from '@convex/lib/marketingOrigin';
import { initConvexTest } from './test.setup';

afterEach(() => {
	vi.unstubAllEnvs();
});

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
		expect(readDodoEnvironment({ DODO_PAYMENTS_ENVIRONMENT: 'test_mode' })).toBe('test_mode');
		expect(() => readDodoEnvironment({})).toThrow(
			'DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode.'
		);
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
				monthly: 1,
				monthlyProductId: 'prod_team_monthly',
				annualProductId: 'prod_team_annual'
			});
		});

		await expect(
			t.query(internal.pricingData.getTierProduct, { tierId: 'team', interval: 'monthly' })
		).resolves.toBe('prod_team_monthly');
		await expect(
			t.query(internal.pricingData.getTierProduct, { tierId: 'team', interval: 'annual' })
		).resolves.toBe('prod_team_annual');
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
			t.query(internal.pricingData.getTierProduct, { tierId: 'team', interval: 'annual' })
		).rejects.toThrow('Dodo product "prod_shared" is assigned more than once.');
	});

	it('accepts checkout for an arbitrary tier with a configured product', async () => {
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		vi.stubEnv('DODO_PAYMENTS_WEBHOOK_SECRET', 'whsec_test');
		vi.stubEnv('DODO_PAYMENTS_API_KEY', undefined);
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
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
		expect(() => resolveMarketingPricingUrls({}, 'team')).toThrow('must be configured');
		expect(
			resolveMarketingPricingUrls({ SPROCKET_MARKETING_ORIGIN: 'https://spikonado.com' }, 'team')
		).toEqual({
			return_url: 'https://spikonado.com/pricing?checkout=return&tier=team',
			cancel_url: 'https://spikonado.com/pricing?checkout=cancel&tier=team'
		});
		expect(
			resolveMarketingPricingUrls(
				{
					SPROCKET_MARKETING_ORIGIN: 'http://localhost:4321',
					DODO_PAYMENTS_ENVIRONMENT: 'test_mode'
				},
				'team'
			)
		).toEqual({
			return_url: 'http://localhost:4321/pricing?checkout=return&tier=team',
			cancel_url: 'http://localhost:4321/pricing?checkout=cancel&tier=team'
		});
		expect(() =>
			resolveMarketingPricingUrls(
				{
					SPROCKET_MARKETING_ORIGIN: 'http://localhost:4321',
					DODO_PAYMENTS_ENVIRONMENT: 'live_mode'
				},
				'team'
			)
		).toThrow('not an approved billing origin');
		expect(
			resolveMarketingPricingUrls(
				{ SPROCKET_MARKETING_ORIGIN: 'https://spikonado.com' },
				'team/plus'
			)
		).toEqual({
			return_url: 'https://spikonado.com/pricing?checkout=return&tier=team%2Fplus',
			cancel_url: 'https://spikonado.com/pricing?checkout=cancel&tier=team%2Fplus'
		});
	});
});

describe('Dodo subscription persistence', () => {
	beforeEach(() => {
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
	});

	it('reuses a matching checkout reservation and replaces it when the selection changes', async () => {
		const t = initConvexTest();

		const first = await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_checkout',
			tierId: 'pro',
			interval: 'monthly',
			productId: 'prod_monthly',
			now: 1_000
		});

		expect(first).toMatchObject({
			kind: 'create',
			interval: 'monthly',
			productId: 'prod_monthly'
		});

		if (first.kind !== 'create') throw new Error('Expected a fresh reservation.');

		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_checkout',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				now: 2_000
			})
		).resolves.toMatchObject({ kind: 'create', attemptId: first.attemptId });
		await t.mutation(internal.billing.attachCheckoutSession, {
			userId: 'user_checkout',
			attemptId: first.attemptId,
			checkoutUrl: 'https://checkout.example/session_1',
			sessionId: 'cks_1'
		});

		const replaced = await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_checkout',
			tierId: 'pro',
			interval: 'annual',
			productId: 'prod_annual',
			now: 3_000
		});

		expect(replaced).toMatchObject({
			kind: 'create',
			interval: 'annual',
			productId: 'prod_annual'
		});

		if (replaced.kind !== 'create') throw new Error('Expected a fresh reservation.');

		expect(replaced.attemptId).not.toBe(first.attemptId);

		await expect(
			t.query(internal.billing.lookupCheckoutAttempt, {
				userId: 'user_checkout',
				attemptId: first.attemptId
			})
		).resolves.toMatchObject({
			attemptId: first.attemptId,
			productId: 'prod_monthly',
			checkoutUrl: 'https://checkout.example/session_1',
			dodoSessionId: 'cks_1'
		});

		await t.mutation(internal.billing.attachCheckoutSession, {
			userId: 'user_checkout',
			attemptId: replaced.attemptId,
			checkoutUrl: 'https://checkout.example/session_annual'
		});
		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_checkout',
				tierId: 'pro',
				interval: 'annual',
				productId: 'prod_annual',
				now: 3_500
			})
		).resolves.toEqual({
			kind: 'existing',
			attemptId: replaced.attemptId,
			checkoutUrl: 'https://checkout.example/session_annual'
		});

		const otherTier = await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_checkout',
			tierId: 'team',
			interval: 'monthly',
			productId: 'prod_team',
			now: 4_000
		});

		expect(otherTier).toMatchObject({
			kind: 'create',
			interval: 'monthly',
			productId: 'prod_team'
		});

		if (otherTier.kind !== 'create') throw new Error('Expected a fresh reservation.');

		await expect(
			t.query(internal.billing.lookupCheckoutAttempt, {
				userId: 'user_checkout',
				attemptId: replaced.attemptId
			})
		).resolves.toMatchObject({ productId: 'prod_annual' });
	});

	it('keeps stable idempotency keys across selection changes', async () => {
		const t = initConvexTest();

		const first = await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_checkout',
			tierId: 'pro',
			interval: 'monthly',
			productId: 'prod_monthly',
			now: 1_000
		});

		if (first.kind !== 'create' || !first.idempotencyKey) {
			throw new Error('Expected a fresh reservation with an idempotency key.');
		}

		const same = await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_checkout',
			tierId: 'pro',
			interval: 'monthly',
			productId: 'prod_monthly',
			now: 2_000
		});

		expect(same).toMatchObject({
			kind: 'create',
			attemptId: first.attemptId,
			idempotencyKey: first.idempotencyKey
		});

		const changed = await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_checkout',
			tierId: 'pro',
			interval: 'annual',
			productId: 'prod_annual',
			now: 3_000
		});

		if (changed.kind !== 'create' || !changed.idempotencyKey) {
			throw new Error('Expected a fresh reservation with an idempotency key.');
		}

		expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
	});

	it('does not invent a provider key for a legacy ambiguous row without one', async () => {
		const t = initConvexTest();

		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutAttempts', {
				userId: 'user_legacy',
				attemptId: 'attempt_legacy',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				outcome: 'create_ambiguous',
				expiresAt: 500
			});
		});

		const resumed = await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_legacy',
			tierId: 'pro',
			interval: 'monthly',
			productId: 'prod_monthly',
			now: 2_000
		});

		expect(resumed).toMatchObject({ kind: 'create', attemptId: 'attempt_legacy' });

		if (resumed.kind !== 'create') throw new Error('Expected the ambiguous resume path.');

		expect(resumed.idempotencyKey).toBeUndefined();
		expect(resumed.createRequest).toBeUndefined();
	});

	it('replaces an expired checkout reservation', async () => {
		const t = initConvexTest();

		const expired = await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'user_checkout',
			tierId: 'pro',
			interval: 'monthly',
			productId: 'prod_monthly',
			now: 1_000
		});

		if (expired.kind !== 'create') throw new Error('Expected a fresh reservation.');

		await t.run(async (ctx) => {
			const reservation = await ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId_and_attemptId', (query) => query.eq('userId', 'user_checkout'))
				.unique();

			if (!reservation) throw new Error('Missing checkout reservation.');
			await ctx.db.patch('billingCheckoutSessions', reservation._id, { expiresAt: 1_999 });
		});

		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'user_checkout',
				tierId: 'pro',
				interval: 'annual',
				productId: 'prod_annual',
				now: 2_000
			})
		).resolves.toMatchObject({
			kind: 'create',
			interval: 'annual',
			productId: 'prod_annual'
		});

		await expect(
			t.query(internal.billing.lookupCheckoutAttempt, {
				userId: 'user_checkout',
				attemptId: expired.attemptId
			})
		).resolves.toMatchObject({ attemptId: expired.attemptId, productId: 'prod_monthly' });
	});
});
