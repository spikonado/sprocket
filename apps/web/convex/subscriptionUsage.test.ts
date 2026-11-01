import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, components, internal } from '@convex/_generated/api';
import { gatewayQuotaStatus } from '@convex/lib/rateLimits';
import { initConvexTest, type ConvexTestInstance } from './test.setup';

const UNITS_PER_DOLLAR = 1_000_000_000;

/** Mirror of the ai-gateway tiers document so quota tests run without network. */
async function seedTiers(t: ConvexTestInstance): Promise<void> {
	await t.run(async (ctx) => {
		const tiers = [
			{
				tierId: 'free',
				label: 'Free',
				monthly: 15 * UNITS_PER_DOLLAR
			},
			{
				tierId: 'pro',
				label: 'Pro',
				monthlyProductId: 'prod_pro',
				monthly: 75 * UNITS_PER_DOLLAR
			},
			{
				tierId: 'max',
				label: 'Max',
				monthlyProductId: 'prod_max',
				monthly: 500 * UNITS_PER_DOLLAR
			}
		];

		for (const tier of tiers) {
			await ctx.db.insert('tiers', tier);
		}
	});
}

async function seedActiveSubscription(
	t: ConvexTestInstance,
	userId: string,
	now: number,
	billingPeriodEnd: number
) {
	const subscription = {
		userId,
		tier: 'pro',
		dodoSubscriptionId: `sub_${userId}`,
		dodoProductId: 'prod_pro',
		dodoCustomerId: `cus_${userId}`,
		status: 'active' as const,
		eventAt: now,
		billingInterval: 'monthly' as const,
		billingPeriodStart: now - 60_000,
		billingPeriodEnd,
		cancelAtNextBillingDate: false
	};

	await t.mutation(internal.billing.upsertDodoSubscription, subscription);
	await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
		userId,
		count: 8 * UNITS_PER_DOLLAR
	});
	const asUser = t.withIdentity({ subject: userId });

	return {
		subscription,
		monthlyUsage: async () =>
			(await asUser.query(api.usage.getMyUsage, { now: Date.now() })).meters[0]?.used
	};
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
		await expect(t.mutation(internal.lib.rateLimits.checkUsageLimits, { userId })).rejects.toThrow(
			/Usage limit reached/
		);
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, userId))).toMatchObject({
			exhausted: true
		});

		await setAllowance(UNITS_PER_DOLLAR);
		await t.mutation(internal.lib.rateLimits.checkUsageLimits, { userId });
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, userId))).toMatchObject({
			exhausted: false
		});
		expect(await asUser.query(api.usage.getMyUsage, { now: Date.now() })).toMatchObject({
			exhausted: false
		});
	});

	it('gives Max $500 of monthly usage and mirrors it in the released windows shape', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_max';
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId,
				tier: 'max',
				status: 'active',
				eventAt: 1
			});
		});

		const usage = await t
			.withIdentity({ subject: userId })
			.query(api.usage.getMyUsage, { now: Date.now() });

		expect(usage.tier).toBe('max');
		expect(usage.tierLabel).toBe('Max');
		const window = { used: 0, limit: 500 * UNITS_PER_DOLLAR, resetsAt: expect.any(Number) };
		expect(usage.meters[0]).toMatchObject(window);
		expect(usage.meters[0]?.windows).toEqual([{ period: 'monthly', ...window }]);
	});

	it('reports usage overdraft and preserves it', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_usage';
		const asUser = t.withIdentity({ subject: userId });
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: 16 * UNITS_PER_DOLLAR
		});

		const usage = await asUser.query(api.usage.getMyUsage, { now: Date.now() });
		expect(usage.meters.map((meter) => meter.id)).toEqual(['modelUsage']);
		const model = usage.meters.find((meter) => meter.id === 'modelUsage');
		expect(model && model.used > model.limit).toBe(true);
		expect(usage.exhausted).toBe(true);
		expect(usage.resetsAt).not.toBeNull();
		await expect(
			t.mutation(internal.lib.rateLimits.checkUsageLimits, {
				userId
			})
		).rejects.toThrow(/Usage limit reached/);
	});

	it('carries old first-use usage into the calendar window on the first new charge', async () => {
		vi.setSystemTime(Date.parse('2026-02-10T00:00:00Z'));
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_legacy_usage';

		await t.mutation(components.rateLimiter.lib.rateLimit, {
			name: 'modelUsageMonthly',
			key: userId,
			config: {
				kind: 'fixed window',
				rate: 15 * UNITS_PER_DOLLAR,
				period: 30 * 86_400_000,
				start: Date.parse('2026-02-03T00:00:00Z')
			},
			count: 2 * UNITS_PER_DOLLAR,
			reserve: true
		});
		const asUser = t.withIdentity({ subject: userId });

		const used = async () =>
			(await asUser.query(api.usage.getMyUsage, { now: Date.now() })).meters[0]?.used;

		expect(await used()).toBe(2 * UNITS_PER_DOLLAR);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: UNITS_PER_DOLLAR
		});
		expect(await used()).toBe(3 * UNITS_PER_DOLLAR);
	});

	it('keeps old first-use usage after access backfill without a reset timestamp', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_legacy_usage_backfill';
		const now = Date.parse('2026-02-10T00:00:00Z');
		vi.setSystemTime(now);

		await t.run((ctx) =>
			ctx.db.insert('subscriptions', {
				userId,
				tier: 'pro',
				status: 'active',
				eventAt: now - 1000,
				dodoSubscriptionId: 'sub_legacy_usage_backfill',
				dodoProductId: 'prod_pro',
				billingInterval: 'monthly',
				billingPeriodStart: Date.parse('2026-02-03T00:00:00Z'),
				billingPeriodEnd: now + 60_000
			})
		);
		await t.mutation(components.rateLimiter.lib.rateLimit, {
			name: 'modelUsageMonthly',
			key: userId,
			config: {
				kind: 'fixed window',
				rate: 75 * UNITS_PER_DOLLAR,
				period: 30 * 86_400_000,
				start: Date.parse('2026-02-03T00:00:00Z')
			},
			count: 2 * UNITS_PER_DOLLAR,
			reserve: true
		});
		const asUser = t.withIdentity({ subject: userId });

		const used = async () =>
			(await asUser.query(api.usage.getMyUsage, { now: Date.now() })).meters[0]?.used;

		expect(await used()).toBe(2 * UNITS_PER_DOLLAR);
		await t.mutation(internal.migrations.backfillSubscriptionAccess, {
			cursor: null,
			dryRun: false,
			oneBatchOnly: true
		});
		expect(await used()).toBe(2 * UNITS_PER_DOLLAR);

		const migrated = await t.run((ctx) =>
			ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', userId))
				.unique()
		);

		expect(migrated).toMatchObject({ quotaGeneration: 0 });
	});

	it('rolls the monthly usage window when the client supplies a later now', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_usage_rollover';
		const asUser = t.withIdentity({ subject: userId });
		const chargedAt = Date.now();
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: 16 * UNITS_PER_DOLLAR
		});

		const duringWindow = await asUser.query(api.usage.getMyUsage, { now: chargedAt });
		expect(duringWindow.exhausted).toBe(true);

		const nextMonth = await asUser.query(api.usage.getMyUsage, {
			now: chargedAt + 32 * 24 * 60 * 60 * 1_000
		});

		expect(nextMonth.meters[0]?.used).toBe(0);
		expect(nextMonth.exhausted).toBe(false);
	});

	it('uses only active subscriptions and ignores stale rows', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_billing';
		const asUser = t.withIdentity({ subject: userId });

		const currentTier = async () =>
			(await asUser.query(api.usage.getMyUsage, { now: Date.now() })).tier;

		expect(await currentTier()).toBe('free');

		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId,
				tier: 'pro',
				status: 'active',
				eventAt: 1_000
			});
		});
		expect(await currentTier()).toBe('pro');

		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId,
				tier: 'pro',
				status: 'cancelled',
				eventAt: 2_000
			});
		});
		expect(await currentTier()).toBe('free');

		// An older 'active' row must not resurrect the subscription.
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId,
				tier: 'pro',
				status: 'active',
				eventAt: 1_500
			});
		});
		expect(await currentTier()).toBe('free');
	});

	it('dedupes to the newest event so a cancellation beats an older active row', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_dedup';
		const asUser = t.withIdentity({ subject: userId, email: `${userId}@example.com` });
		const shared = { userId, tier: 'pro' } as const;
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', { ...shared, status: 'active', eventAt: 1_000 });
			await ctx.db.insert('subscriptions', { ...shared, status: 'cancelled', eventAt: 2_000 });
		});

		expect((await asUser.query(api.usage.getMyUsage, { now: Date.now() })).tier).toBe('free');

		// Ensuring collapses the duplicates onto the newer cancellation.
		await asUser.mutation(api.billing.ensureMySubscription, {});

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', userId))
				.collect()
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'cancelled', eventAt: 2_000 });
	});

	it('ensures a free subscription row and leaves existing grants alone', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_ensure_free';
		const asUser = t.withIdentity({ subject: userId, email: `${userId}@example.com` });

		const readSubscription = () =>
			t.run(async (ctx) =>
				ctx.db
					.query('subscriptions')
					.withIndex('by_userId', (query) => query.eq('userId', userId))
					.unique()
			);

		expect(await readSubscription()).toBeNull();
		await asUser.mutation(api.billing.ensureMySubscription, {});
		const created = await readSubscription();
		expect(created).toMatchObject({ userId, tier: 'free', status: 'active', eventAt: 0 });
		expect(created).not.toHaveProperty('dodoSubscriptionId');
		expect(created).not.toHaveProperty('dodoProductId');

		await t.run(async (ctx) => {
			if (!created) throw new Error('Expected subscription row');
			await ctx.db.patch('subscriptions', created._id, { tier: 'pro', eventAt: 5_000 });
		});
		await asUser.mutation(api.billing.ensureMySubscription, {});
		expect(await readSubscription()).toMatchObject({
			userId,
			tier: 'pro',
			status: 'active',
			eventAt: 5_000
		});
	});

	it('lets operator edits replace a bootstrap free row', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_bootstrap_upgrade';
		const asUser = t.withIdentity({ subject: userId, email: `${userId}@example.com` });
		await asUser.mutation(api.billing.ensureMySubscription, {});

		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', { userId, tier: 'pro', status: 'active', eventAt: 1 });
		});
		expect(await asUser.query(api.usage.getMyUsage, { now: Date.now() })).toMatchObject({
			tier: 'pro'
		});
	});

	it('fails fast on duplicate tier rows instead of metering arbitrarily', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_dup_tier';
		const asUser = t.withIdentity({ subject: userId });
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', { userId, tier: 'pro', status: 'active', eventAt: 1 });
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro Duplicate',
				monthly: 2
			});
		});
		await expect(asUser.query(api.usage.getMyUsage, { now: Date.now() })).rejects.toThrow(
			'Duplicate tiers rows for tier "pro".'
		);
	});

	it('lets newer rows win regardless of tier', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_recency';
		const asUser = t.withIdentity({ subject: userId });

		const currentTier = async () =>
			(await asUser.query(api.usage.getMyUsage, { now: Date.now() })).tier;

		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId,
				tier: 'pro',
				status: 'active',
				eventAt: 1_000
			});
		});
		expect(await currentTier()).toBe('pro');
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId,
				tier: 'max',
				status: 'active',
				eventAt: 2_000
			});
		});
		expect(await currentTier()).toBe('max');
	});

	it('meters each tier against its own limits', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_max_metered';
		const asUser = t.withIdentity({ subject: userId });
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId,
				tier: 'max',
				status: 'active',
				eventAt: 1
			});
		});
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: 6 * UNITS_PER_DOLLAR
		});
		// 6 dollars of usage is far below the max tier's own limits.
		await t.mutation(internal.lib.rateLimits.checkUsageLimits, {
			userId
		});
		const usage = await asUser.query(api.usage.getMyUsage, { now: Date.now() });
		expect(usage.tier).toBe('max');
		expect(usage.tierLabel).toBe('Max');
		expect(usage.exhausted).toBe(false);
		expect(usage.meters[0]).toMatchObject({ used: 6 * UNITS_PER_DOLLAR });
	});

	it('resets usage on confirmed plan changes, but preserves it on duplicate events and cancellation', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();

		const { subscription, monthlyUsage } = await seedActiveSubscription(
			t,
			'user_upgrade',
			now,
			now + 30 * 86_400_000
		);

		expect(await monthlyUsage()).toBe(8 * UNITS_PER_DOLLAR);

		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			tier: 'max',
			dodoProductId: 'prod_max',
			eventAt: now + 1
		});
		expect(await monthlyUsage()).toBe(0);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId: subscription.userId,
			count: 30 * UNITS_PER_DOLLAR
		});
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			tier: 'max',
			dodoProductId: 'prod_max',
			eventAt: now + 2
		});
		expect(await monthlyUsage()).toBe(30 * UNITS_PER_DOLLAR);
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			tier: 'max',
			dodoProductId: 'prod_max',
			status: 'cancelled',
			cancelAtNextBillingDate: true,
			eventAt: now + 3
		});
		expect(await monthlyUsage()).toBe(30 * UNITS_PER_DOLLAR);

		await vi.advanceTimersByTimeAsync(subscription.billingPeriodEnd - Date.now());
		await t.finishInProgressScheduledFunctions();
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			eventAt: Date.now(),
			billingPeriodStart: subscription.billingPeriodEnd,
			billingPeriodEnd: subscription.billingPeriodEnd + 30 * 86_400_000
		});
		expect(await monthlyUsage()).toBe(0);
		await t.mutation(internal.lib.rateLimits.checkUsageLimits, { userId: subscription.userId });
	});

	it('resets usage when a confirmed plan change has identical allowances', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				monthlyProductId: 'prod_team',
				monthly: 75 * UNITS_PER_DOLLAR
			})
		);

		const { subscription, monthlyUsage } = await seedActiveSubscription(
			t,
			'user_equal_allowances',
			now,
			now + 60_000
		);

		expect(await monthlyUsage()).toBe(8 * UNITS_PER_DOLLAR);

		const planChange = {
			...subscription,
			tier: 'team',
			dodoProductId: 'prod_team',
			eventAt: subscription.eventAt + 1
		};

		await t.mutation(internal.billing.upsertDodoSubscription, planChange);
		expect(await monthlyUsage()).toBe(0);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId: subscription.userId,
			count: UNITS_PER_DOLLAR
		});
		await t.mutation(internal.billing.upsertDodoSubscription, planChange);
		expect(await monthlyUsage()).toBe(UNITS_PER_DOLLAR);
	});

	it('a renewal term advance opens the new window without minting extra allowance', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();

		const { subscription, monthlyUsage } = await seedActiveSubscription(
			t,
			'user_renewal',
			now,
			now + 30 * 86_400_000
		);

		expect(await monthlyUsage()).toBe(8 * UNITS_PER_DOLLAR);

		const quotaGeneration = async () =>
			(
				await t.run((ctx) =>
					ctx.db
						.query('subscriptions')
						.withIndex('by_userId', (query) => query.eq('userId', subscription.userId))
						.unique()
				)
			)?.quotaGeneration;

		const generationBefore = await quotaGeneration();

		// Renewal: same product, same tier, new confirmed term. The monthly
		// window opens empty because the window start advanced — NOT because a
		// new usage generation was minted.
		const renewed = await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			eventAt: now + 30 * 86_400_000,
			billingPeriodStart: now + 30 * 86_400_000,
			billingPeriodEnd: now + 60 * 86_400_000
		});

		expect(renewed.outcome).toBe('applied');
		expect(await monthlyUsage()).toBe(0);
		expect(await quotaGeneration()).toBe(generationBefore);

		// A redelivered renewal and a status-only touch at a later event time
		// must not mint a new usage generation.
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			eventAt: now + 30 * 86_400_000,
			billingPeriodStart: now + 30 * 86_400_000,
			billingPeriodEnd: now + 60 * 86_400_000
		});
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			eventAt: now + 31 * 86_400_000,
			billingPeriodStart: now + 30 * 86_400_000,
			billingPeriodEnd: now + 60 * 86_400_000
		});
		expect(await quotaGeneration()).toBe(generationBefore);
	});

	it('an older redelivered plan-change event cannot mint a second reset', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();

		const { subscription, monthlyUsage } = await seedActiveSubscription(
			t,
			'user_plan_dedupe',
			now,
			now + 30 * 86_400_000
		);

		// Confirmed plan change resets once.
		const change = await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			dodoProductId: 'prod_max',
			eventAt: now + 10
		});

		expect(change.outcome).toBe('applied');
		expect(await monthlyUsage()).toBe(0);

		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId: subscription.userId,
			count: 5 * UNITS_PER_DOLLAR
		});

		// The same plan-change event redelivered is an ordering no-op and keeps
		// the charged usage.
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			dodoProductId: 'prod_max',
			eventAt: now + 10
		});
		expect(await monthlyUsage()).toBe(5 * UNITS_PER_DOLLAR);
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
