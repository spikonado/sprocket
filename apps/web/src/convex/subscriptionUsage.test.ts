import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('subscription and usage backend', () => {
	it('reports usage overdraft and preserves it', async () => {
		const t = initConvexTest();
		const userId = 'user_usage';
		const asUser = t.withIdentity({ subject: userId });
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: 20_000
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

	it('uses only active subscriptions and ignores stale webhook events', async () => {
		const t = initConvexTest();
		const userId = 'user_billing';
		const asUser = t.withIdentity({ subject: userId });
		const currentTier = async () => (await asUser.query(api.usage.getMyUsage, {})).tier;
		const subscription = {
			userId,
			tier: 'pro',
			dodoSubscriptionId: 'sub_1',
			dodoProductId: 'prod_1',
			dodoCustomerId: 'customer_1'
		} as const;
		expect(await currentTier()).toBe('free');

		await t.mutation(internal.billing.upsertSubscription, {
			...subscription,
			status: 'active',
			eventAt: 1_000
		});
		expect(await currentTier()).toBe('pro');

		await t.mutation(internal.billing.upsertSubscription, {
			...subscription,
			status: 'cancelled',
			eventAt: 2_000
		});
		expect(await currentTier()).toBe('free');

		// A late-arriving older 'active' event must not resurrect the subscription.
		await t.mutation(internal.billing.upsertSubscription, {
			...subscription,
			status: 'active',
			eventAt: 1_500
		});
		expect(await currentTier()).toBe('free');
	});

	it('dedupes to the newest event so a cancellation beats an older active row', async () => {
		const t = initConvexTest();
		const userId = 'user_dedup';
		const asUser = t.withIdentity({ subject: userId, email: `${userId}@example.com` });
		const shared = {
			userId,
			tier: 'pro',
			dodoSubscriptionId: 'sub_dup',
			dodoProductId: 'prod_dup'
		} as const;
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
		expect(created?.dodoSubscriptionId).toBe('');
		expect(created?.dodoProductId).toBe('');

		await t.run(async (ctx) => {
			if (!created) throw new Error('Expected subscription row');
			await ctx.db.patch('subscriptions', created._id, { tier: 'admin', eventAt: 5_000 });
		});
		await asUser.mutation(api.billing.ensureMySubscription, {});
		expect(await readSubscription()).toMatchObject({
			userId,
			tier: 'admin',
			status: 'active',
			eventAt: 5_000
		});
	});

	it('lets paid webhooks replace a bootstrap free row', async () => {
		const t = initConvexTest();
		const userId = 'user_bootstrap_upgrade';
		const asUser = t.withIdentity({ subject: userId, email: `${userId}@example.com` });
		await asUser.mutation(api.billing.ensureMySubscription, {});

		await t.mutation(internal.billing.upsertSubscription, {
			userId,
			tier: 'pro',
			dodoSubscriptionId: 'sub_upgrade',
			dodoProductId: 'prod_upgrade',
			dodoCustomerId: 'customer_upgrade',
			status: 'active',
			eventAt: 1
		});
		expect(await asUser.query(api.usage.getMyUsage, {})).toMatchObject({ tier: 'pro' });
	});

	it('keeps admin grants above Dodo webhook upserts', async () => {
		const t = initConvexTest();
		const userId = 'user_admin_grant';
		const asUser = t.withIdentity({ subject: userId });
		const currentTier = async () => (await asUser.query(api.usage.getMyUsage, {})).tier;
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId,
				tier: 'admin',
				dodoSubscriptionId: '',
				dodoProductId: '',
				status: 'active',
				eventAt: 1_000
			});
		});
		const webhook = {
			userId,
			tier: 'pro' as const,
			dodoSubscriptionId: 'sub_admin',
			dodoProductId: 'prod_admin',
			dodoCustomerId: 'customer_admin'
		};

		await t.mutation(internal.billing.upsertSubscription, {
			...webhook,
			status: 'active',
			eventAt: 2_000
		});
		expect(await currentTier()).toBe('admin');
		const customer = await t.run(async (ctx) =>
			ctx.db
				.query('billingCustomers')
				.withIndex('by_userId', (query) => query.eq('userId', userId))
				.unique()
		);
		expect(customer?.dodoCustomerId).toBe('customer_admin');

		await t.mutation(internal.billing.upsertSubscription, {
			...webhook,
			status: 'cancelled',
			eventAt: 3_000
		});
		expect(await currentTier()).toBe('admin');
	});

	it('lets admin bypass meters after free overdraft', async () => {
		const t = initConvexTest();
		const userId = 'user_admin_bypass';
		const asUser = t.withIdentity({ subject: userId });
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: 20_000
		});
		await expect(
			t.mutation(internal.lib.rateLimits.checkUsageLimits, {
				userId
			})
		).rejects.toThrow(/model usage limit reached/);

		await t.run(async (ctx) => {
			const existing = await ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', userId))
				.unique();
			if (!existing) throw new Error('Expected subscription row');
			await ctx.db.patch('subscriptions', existing._id, { tier: 'admin' });
		});

		await t.mutation(internal.lib.rateLimits.checkUsageLimits, {
			userId
		});
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId,
			count: 20_000
		});
		const usage = await asUser.query(api.usage.getMyUsage, {});
		expect(usage.tier).toBe('admin');
		const weekly = usage.meters
			.find((meter) => meter.id === 'modelUsage')
			?.windows.find((window) => window.period === 'weekly');
		expect(weekly).toMatchObject({ used: 0 });
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
