import { DAY, RateLimiter } from '@convex-dev/rate-limiter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, components } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { billingWindow } from '@convex/lib/billingWindows';
import { chargeUsage, gatewayQuotaStatus } from '@convex/lib/quota';
import { MODEL_USAGE_UNITS_PER_DOLLAR, RENEWAL_GRACE_MS } from '@convex/lib/tiers';
import { initConvexTest, insertUser, seedTiers, type ConvexTestInstance } from './test.setup';

function insertSubscription(
	t: ConvexTestInstance,
	userId: string,
	overrides: Partial<Doc<'subscriptions'>> = {}
) {
	const now = Date.now();

	return t.run((ctx) =>
		ctx.db.insert('subscriptions', {
			userId,
			dodoSubscriptionId: `sub_${crypto.randomUUID()}`,
			dodoProductId: 'prod_pro',
			status: 'active',
			billingPeriodStart: now - 60_000,
			billingPeriodEnd: now + 30 * DAY,
			cancelAtNextBillingDate: false,
			syncedAt: now,
			...overrides
		})
	);
}

function readTier(t: ConvexTestInstance, userId: string, now = Date.now()) {
	return t
		.withIdentity({ subject: userId })
		.query(api.usage.getMyUsage, { now })
		.then((usage) => usage.tier);
}

describe('subscription and usage backend', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('blocks a zero monthly allowance at zero usage and permits a positive allowance', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_zero_allowance';

		const tierId = await t.run(async (ctx) => {
			const tier = await ctx.db
				.query('tiers')
				.withIndex('by_tierId', (q) => q.eq('tierId', 'free'))
				.unique();

			if (!tier) throw new Error('Missing Free tier.');

			return tier._id;
		});

		const setAllowance = (monthly: number) =>
			t.run((ctx) => ctx.db.patch('tiers', tierId, { monthly }));

		await setAllowance(0);
		const asUser = t.withIdentity({ subject: userId });
		const usage = await asUser.query(api.usage.getMyUsage, { now: Date.now() });

		expect(usage).toMatchObject({ exhausted: true });
		expect(usage.meters[0]).toMatchObject({ limit: 0, used: 0 });
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, userId))).toMatchObject({
			exhausted: true,
			message: expect.stringMatching(/^Usage limit reached\. Try again in /)
		});

		await setAllowance(MODEL_USAGE_UNITS_PER_DOLLAR);
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, userId))).toMatchObject({
			exhausted: false
		});
		expect(await asUser.query(api.usage.getMyUsage, { now: Date.now() })).toMatchObject({
			exhausted: false
		});
	});

	it('meters a Max subscription against $500 of monthly usage', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_max';
		await insertSubscription(t, userId, { dodoProductId: 'prod_max' });
		await t.run((ctx) => chargeUsage(ctx, userId, 6 * MODEL_USAGE_UNITS_PER_DOLLAR));

		const usage = await t
			.withIdentity({ subject: userId })
			.query(api.usage.getMyUsage, { now: Date.now() });

		expect(usage).toMatchObject({ tier: 'max', tierLabel: 'Max', exhausted: false });
		expect(usage.meters[0]).toMatchObject({
			used: 6 * MODEL_USAGE_UNITS_PER_DOLLAR,
			limit: 500 * MODEL_USAGE_UNITS_PER_DOLLAR
		});
	});

	it('reports usage overdraft and preserves it', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_usage';
		const asUser = t.withIdentity({ subject: userId });
		await t.run((ctx) => chargeUsage(ctx, userId, 16 * MODEL_USAGE_UNITS_PER_DOLLAR));

		const usage = await asUser.query(api.usage.getMyUsage, { now: Date.now() });
		expect(usage.meters.map((meter) => meter.id)).toEqual(['modelUsage']);
		const model = usage.meters.find((meter) => meter.id === 'modelUsage');
		expect(model && model.used > model.limit).toBe(true);
		expect(usage.exhausted).toBe(true);
		expect(usage.resetsAt).not.toBeNull();
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, userId))).toMatchObject({
			exhausted: true
		});
	});

	it('counts usage the rate limiter recorded before the usage table', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_legacy_usage';
		const asUser = t.withIdentity({ subject: userId });
		const { start } = billingWindow(null, Date.now());

		await t.run((ctx) =>
			new RateLimiter(components.rateLimiter, {}).limit(ctx, 'modelUsageMonthly', {
				key: `${userId}:monthly:${start}:0`,
				config: { kind: 'fixed window', period: 365 * DAY, rate: 4e15, start },
				count: 7,
				reserve: true
			})
		);

		const monthlyUsage = async () =>
			(await asUser.query(api.usage.getMyUsage, { now: Date.now() })).meters[0]?.used;

		expect(await monthlyUsage()).toBe(7);
		await t.run((ctx) => chargeUsage(ctx, userId, 2));
		expect(await monthlyUsage()).toBe(9);
	});

	it('rolls the monthly usage window when the client supplies a later now', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_usage_rollover';
		const asUser = t.withIdentity({ subject: userId });
		const chargedAt = Date.now();
		await t.run((ctx) => chargeUsage(ctx, userId, 16 * MODEL_USAGE_UNITS_PER_DOLLAR));

		const duringWindow = await asUser.query(api.usage.getMyUsage, { now: chargedAt });
		expect(duringWindow.exhausted).toBe(true);

		const nextMonth = await asUser.query(api.usage.getMyUsage, { now: chargedAt + 32 * DAY });

		expect(nextMonth.meters[0]?.used).toBe(0);
		expect(nextMonth.exhausted).toBe(false);
	});

	it('opens a new usage window when Dodo renews the billing period', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_renewal';
		const periodEnd = Date.now() + 60_000;
		const id = await insertSubscription(t, userId, { billingPeriodEnd: periodEnd });
		await t.run((ctx) => chargeUsage(ctx, userId, 8 * MODEL_USAGE_UNITS_PER_DOLLAR));

		await vi.advanceTimersByTimeAsync(60_000);
		await t.run((ctx) =>
			ctx.db.patch('subscriptions', id, {
				billingPeriodStart: periodEnd,
				billingPeriodEnd: periodEnd + 30 * DAY
			})
		);

		const usage = await t
			.withIdentity({ subject: userId })
			.query(api.usage.getMyUsage, { now: Date.now() });

		expect(usage).toMatchObject({ tier: 'pro', meters: [{ used: 0 }] });
	});

	it('keeps access through the renewal grace unless the subscription cancels at period end', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const periodEnd = Date.now() + 60_000;
		await insertSubscription(t, 'renewing', { billingPeriodEnd: periodEnd });
		await insertSubscription(t, 'cancelling', {
			billingPeriodEnd: periodEnd,
			cancelAtNextBillingDate: true
		});

		await expect(
			t.withIdentity({ subject: 'cancelling' }).query(api.billing.getMySubscription, {})
		).resolves.toMatchObject({ tier: 'pro', accessPhase: 'scheduled_cancel' });
		expect(await readTier(t, 'cancelling', periodEnd - 1)).toBe('pro');
		expect(await readTier(t, 'cancelling', periodEnd)).toBe('free');
		expect(await readTier(t, 'renewing', periodEnd + RENEWAL_GRACE_MS - 1)).toBe('pro');
		expect(await readTier(t, 'renewing', periodEnd + RENEWAL_GRACE_MS)).toBe('free');
	});

	it('grants access only while Dodo reports the subscription active', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		for (const status of ['pending', 'on_hold', 'past_due', 'paused', 'cancelled'] as const) {
			await insertSubscription(t, `user_${status}`, { status });
			expect(await readTier(t, `user_${status}`)).toBe('free');
		}
	});

	it('uses the highest allowance among subscriptions with access', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await insertSubscription(t, 'user_two_plans', { dodoProductId: 'prod_max' });
		await insertSubscription(t, 'user_two_plans', { dodoProductId: 'prod_pro_annual' });

		expect(await readTier(t, 'user_two_plans')).toBe('max');
	});

	it('lets an operator-granted tier override Dodo subscriptions', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run(async (ctx) => {
			const id = await insertUser(ctx, 'user_granted');
			await ctx.db.patch('users', id, { grantedTier: 'max' });
		});
		await insertSubscription(t, 'user_granted');

		await expect(
			t.withIdentity({ subject: 'user_granted' }).query(api.billing.getMySubscription, {})
		).resolves.toEqual({
			tier: 'max',
			tierLabel: 'Max',
			billingManaged: false,
			accessPhase: 'active'
		});
	});

	it('fails fast on duplicate tier rows instead of metering arbitrarily', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run(async (ctx) => {
			const id = await insertUser(ctx, 'user_dup_tier');
			await ctx.db.patch('users', id, { grantedTier: 'pro' });
			await ctx.db.insert('tiers', { tierId: 'pro', label: 'Pro Duplicate', monthly: 2 });
		});

		await expect(readTier(t, 'user_dup_tier')).rejects.toThrow(
			'Duplicate tiers rows for tier "pro".'
		);
	});

	it('materializes exactly one users row per subject across repeated page loads', async () => {
		const t = initConvexTest();
		const userId = 'user_users_row';
		const asUser = t.withIdentity({ subject: userId, email: `${userId}@example.com` });
		await asUser.mutation(api.billing.ensureMySubscription, {});
		await asUser.mutation(api.billing.ensureMySubscription, {});

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('users')
				.withIndex('by_subject', (query) => query.eq('subject', userId))
				.collect()
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ subject: userId });
	});
});
