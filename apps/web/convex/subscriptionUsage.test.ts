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
				weekly: 5 * UNITS_PER_DOLLAR,
				monthly: 15 * UNITS_PER_DOLLAR
			},
			{
				tierId: 'pro',
				label: 'Pro',
				monthlyProductId: 'prod_pro',
				weekly: 25 * UNITS_PER_DOLLAR,
				monthly: 75 * UNITS_PER_DOLLAR
			},
			{
				tierId: 'max',
				label: 'Max',
				monthlyProductId: 'prod_max',
				weekly: 170 * UNITS_PER_DOLLAR,
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
		windowUsage: async () =>
			(await asUser.query(api.usage.getMyUsage, {})).meters[0]?.windows.map((window) => window.used)
	};
}

describe('subscription and usage backend', () => {
	it('backfills legacy paid access without moving consumed usage or granting expired grace', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();
		const userId = 'legacy_billing';

		const subscriptionId = await t.run((ctx) =>
			ctx.db.insert('subscriptions', {
				userId,
				tier: 'pro',
				status: 'active',
				eventAt: now - 1000,
				dodoSubscriptionId: 'sub_legacy',
				dodoProductId: 'prod_pro',
				billingInterval: 'monthly',
				billingPeriodStart: now - 60_000,
				billingPeriodEnd: now + 60_000,
				quotaResetAt: now - 1000
			})
		);

		await t.run((ctx) =>
			ctx.db.insert('subscriptions', {
				userId: 'long_expired',
				tier: 'pro',
				status: 'active',
				eventAt: now - 86_400_000,
				dodoSubscriptionId: 'sub_expired',
				billingInterval: 'monthly',
				billingPeriodStart: now - 2 * 86_400_000,
				billingPeriodEnd: now - 86_400_000
			})
		);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: 8 * UNITS_PER_DOLLAR
		});
		const asUser = t.withIdentity({ subject: userId });
		const before = await asUser.query(api.usage.getMyUsage, { now });
		await t.mutation(internal.migrations.backfillSubscriptionAccess, {
			cursor: null,
			dryRun: false,
			oneBatchOnly: true
		});
		const after = await asUser.query(api.usage.getMyUsage, { now });
		expect(after.meters[0]?.windows.map((window) => window.used)).toEqual(
			before.meters[0]?.windows.map((window) => window.used)
		);
		const migrated = await t.run((ctx) => ctx.db.get('subscriptions', subscriptionId));
		expect(migrated).toMatchObject({
			accessPhase: 'paid',
			quotaResetAt: now - 1000,
			quotaGeneration: now - 1000
		});
		expect(migrated?.billingPeriodCheckId).toBeDefined();

		const expired = await t.run((ctx) =>
			ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', 'long_expired'))
				.unique()
		);

		expect(expired).toMatchObject({ accessPhase: 'none', quotaGeneration: 0 });
		expect(expired?.terminalConfirmed).not.toBe(true);
		await t.mutation(internal.migrations.backfillSubscriptionAccess, {
			cursor: null,
			dryRun: false,
			oneBatchOnly: true
		});
		expect((await asUser.query(api.usage.getMyUsage, { now })).meters).toEqual(after.meters);
	});
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it.each(['weekly', 'monthly'] as const)(
		'blocks zero %s allowance at zero usage and permits a positive allowance',
		async (period) => {
			const t = initConvexTest();
			await seedTiers(t);
			const userId = `user_zero_${period}`;

			const tierId = await t.run(async (ctx) => {
				const tier = await ctx.db
					.query('tiers')
					.withIndex('by_tierId', (q) => q.eq('tierId', 'free'))
					.unique();

				if (!tier) throw new Error('Missing Free tier.');

				return tier._id;
			});

			const setAllowance = (value: number) =>
				t.run((ctx) => ctx.db.patch('tiers', tierId, { [period]: value }));

			await setAllowance(0);
			const asUser = t.withIdentity({ subject: userId });
			const usage = await asUser.query(api.usage.getMyUsage, {});

			expect(usage).toMatchObject({ exhausted: true });
			expect(usage.meters[0]?.windows.find((window) => window.period === period)).toMatchObject({
				limit: 0,
				used: 0
			});
			await expect(
				t.mutation(internal.lib.rateLimits.checkUsageLimits, { userId })
			).rejects.toThrow(/model usage limit reached/);
			expect(await t.run((ctx) => gatewayQuotaStatus(ctx, userId))).toMatchObject({
				exhausted: true
			});

			await setAllowance(UNITS_PER_DOLLAR);
			await t.mutation(internal.lib.rateLimits.checkUsageLimits, { userId });
			expect(await t.run((ctx) => gatewayQuotaStatus(ctx, userId))).toMatchObject({
				exhausted: false
			});
			expect(await asUser.query(api.usage.getMyUsage, {})).toMatchObject({ exhausted: false });
		}
	);

	it('gives Max $170 of weekly usage and $500 of monthly usage', async () => {
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

		const usage = await t.withIdentity({ subject: userId }).query(api.usage.getMyUsage, {});
		expect(usage.tier).toBe('max');
		expect(usage.tierLabel).toBe('Max');
		expect(usage.meters[0]?.windows).toEqual([
			{ period: 'weekly', used: 0, limit: 170 * UNITS_PER_DOLLAR, resetsAt: expect.any(Number) },
			{ period: 'monthly', used: 0, limit: 500 * UNITS_PER_DOLLAR, resetsAt: expect.any(Number) }
		]);
	});

	it('reports usage overdraft and preserves it', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_usage';
		const asUser = t.withIdentity({ subject: userId });
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: 6 * UNITS_PER_DOLLAR
		});

		const usage = await asUser.query(api.usage.getMyUsage, {});
		expect(usage.meters.map((meter) => meter.id)).toEqual(['modelUsage']);
		const model = usage.meters.find((meter) => meter.id === 'modelUsage');
		const weekly = model?.windows.find((window) => window.period === 'weekly');
		expect(weekly && weekly.used > weekly.limit).toBe(true);
		expect(usage.exhausted).toBe(true);
		expect(usage.resetsAt).not.toBeNull();
		await expect(
			t.mutation(internal.lib.rateLimits.checkUsageLimits, {
				userId
			})
		).rejects.toThrow(/model usage limit reached/);
	});

	it('carries old first-use usage into the calendar window on the first new charge', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_legacy_usage';
		const today = new Date();

		const monday =
			Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) -
			((today.getUTCDay() + 6) % 7) * 86_400_000;

		await t.mutation(components.rateLimiter.lib.rateLimit, {
			name: 'modelUsageWeekly',
			key: userId,
			config: {
				kind: 'fixed window',
				rate: 5 * UNITS_PER_DOLLAR,
				period: 7 * 86_400_000,
				start: monday
			},
			count: 2 * UNITS_PER_DOLLAR,
			reserve: true
		});
		const asUser = t.withIdentity({ subject: userId });

		const used = async () =>
			(await asUser.query(api.usage.getMyUsage, {})).meters[0]?.windows[0]?.used;

		expect(await used()).toBe(2 * UNITS_PER_DOLLAR);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: UNITS_PER_DOLLAR
		});
		expect(await used()).toBe(3 * UNITS_PER_DOLLAR);
	});

	it('uses only active subscriptions and ignores stale rows', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_billing';
		const asUser = t.withIdentity({ subject: userId });
		const currentTier = async () => (await asUser.query(api.usage.getMyUsage, {})).tier;
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

		expect((await asUser.query(api.usage.getMyUsage, {})).tier).toBe('free');

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
		expect(await asUser.query(api.usage.getMyUsage, {})).toMatchObject({ tier: 'pro' });
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
				weekly: 1,
				monthly: 2
			});
		});
		await expect(asUser.query(api.usage.getMyUsage, {})).rejects.toThrow(
			'Duplicate tiers rows for tier "pro".'
		);
	});

	it('lets newer rows win regardless of tier', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const userId = 'user_recency';
		const asUser = t.withIdentity({ subject: userId });
		const currentTier = async () => (await asUser.query(api.usage.getMyUsage, {})).tier;
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
		const usage = await asUser.query(api.usage.getMyUsage, {});
		expect(usage.tier).toBe('max');
		expect(usage.tierLabel).toBe('Max');
		expect(usage.exhausted).toBe(false);

		const weekly = usage.meters
			.find((meter) => meter.id === 'modelUsage')
			?.windows.find((window) => window.period === 'weekly');

		expect(weekly).toMatchObject({ used: 6 * UNITS_PER_DOLLAR });
	});

	it('resets both windows on confirmed plan changes, but preserves usage on duplicate events and cancellation', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();

		const { subscription, windowUsage } = await seedActiveSubscription(
			t,
			'user_upgrade',
			now,
			now + 30 * 86_400_000
		);

		expect(await windowUsage()).toEqual([8 * UNITS_PER_DOLLAR, 8 * UNITS_PER_DOLLAR]);

		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			tier: 'max',
			dodoProductId: 'prod_max',
			eventAt: now + 1
		});
		expect(await windowUsage()).toEqual([0, 0]);
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
		expect(await windowUsage()).toEqual([30 * UNITS_PER_DOLLAR, 30 * UNITS_PER_DOLLAR]);
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			tier: 'max',
			dodoProductId: 'prod_max',
			status: 'cancelled',
			cancelAtNextBillingDate: true,
			eventAt: now + 3
		});
		expect(await windowUsage()).toEqual([30 * UNITS_PER_DOLLAR, 30 * UNITS_PER_DOLLAR]);

		await vi.advanceTimersByTimeAsync(subscription.billingPeriodEnd - Date.now());
		await t.finishInProgressScheduledFunctions();
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...subscription,
			eventAt: Date.now(),
			billingPeriodStart: subscription.billingPeriodEnd,
			billingPeriodEnd: subscription.billingPeriodEnd + 30 * 86_400_000
		});
		expect(await windowUsage()).toEqual([0, 0]);
		await t.mutation(internal.lib.rateLimits.checkUsageLimits, { userId: subscription.userId });
	});

	it('resets both windows when a confirmed plan change has identical allowances', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				monthlyProductId: 'prod_team',
				weekly: 25 * UNITS_PER_DOLLAR,
				monthly: 75 * UNITS_PER_DOLLAR
			})
		);

		const { subscription, windowUsage } = await seedActiveSubscription(
			t,
			'user_equal_allowances',
			now,
			now + 60_000
		);

		expect(await windowUsage()).toEqual([8 * UNITS_PER_DOLLAR, 8 * UNITS_PER_DOLLAR]);

		const planChange = {
			...subscription,
			tier: 'team',
			dodoProductId: 'prod_team',
			eventAt: subscription.eventAt + 1
		};

		await t.mutation(internal.billing.upsertDodoSubscription, planChange);
		expect(await windowUsage()).toEqual([0, 0]);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId: subscription.userId,
			count: UNITS_PER_DOLLAR
		});
		await t.mutation(internal.billing.upsertDodoSubscription, planChange);
		expect(await windowUsage()).toEqual([UNITS_PER_DOLLAR, UNITS_PER_DOLLAR]);
	});

	it('a renewal term advance opens the new window without minting extra allowance', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();

		const { subscription, windowUsage } = await seedActiveSubscription(
			t,
			'user_renewal',
			now,
			now + 30 * 86_400_000
		);

		expect(await windowUsage()).toEqual([8 * UNITS_PER_DOLLAR, 8 * UNITS_PER_DOLLAR]);

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
		expect(await windowUsage()).toEqual([8 * UNITS_PER_DOLLAR, 0]);

		// A redelivered renewal and a status-only touch at a later event time
		// must not reset either window.
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
		expect(await windowUsage()).toEqual([8 * UNITS_PER_DOLLAR, 0]);
	});

	it('an older redelivered plan-change event cannot mint a second reset', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();

		const { subscription, windowUsage } = await seedActiveSubscription(
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
		expect(await windowUsage()).toEqual([0, 0]);

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
		expect(await windowUsage()).toEqual([5 * UNITS_PER_DOLLAR, 5 * UNITS_PER_DOLLAR]);
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
