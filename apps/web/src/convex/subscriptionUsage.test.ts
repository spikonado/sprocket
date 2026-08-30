import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { initConvexTest, subjectTokenIdentifier } from './test.setup';

/** Seed the canonical owner's users row and return the tokenIdentifier. */
async function seedUser(t: ReturnType<typeof initConvexTest>, subject: string): Promise<string> {
	const userId = subjectTokenIdentifier(subject);
	await t.run(async (ctx) => {
		await ctx.db.insert('users', {
			subject,
			tokenIdentifier: userId,
			email: `${subject}@example.com`,
			createdAt: 1
		});
	});
	return userId;
}

describe('subscription and usage backend', () => {
	it('reports usage overdraft and preserves it', async () => {
		const t = initConvexTest();
		const subject = 'user_usage';
		const userId = await seedUser(t, subject);
		const asUser = t.withIdentity({ subject, email: `${subject}@example.com` });
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
		const subject = 'user_billing';
		const userId = await seedUser(t, subject);
		const asUser = t.withIdentity({ subject });
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
		const subject = 'user_dedup';
		const userId = await seedUser(t, subject);
		const asUser = t.withIdentity({ subject, email: `${subject}@example.com` });
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
		const subject = 'user_ensure_free';
		const userId = await seedUser(t, subject);
		const asUser = t.withIdentity({ subject, email: `${subject}@example.com` });
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
		const subject = 'user_bootstrap_upgrade';
		const userId = await seedUser(t, subject);
		const asUser = t.withIdentity({ subject, email: `${subject}@example.com` });
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
		const subject = 'user_admin_grant';
		const userId = await seedUser(t, subject);
		const asUser = t.withIdentity({ subject });
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
		const subject = 'user_admin_bypass';
		const userId = await seedUser(t, subject);
		const asUser = t.withIdentity({ subject });
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

	// Backwards-compat shim: rows written before the tokenIdentifier migration
	// still carry the subject in userId and must stay visible until the
	// owner-rewrite migration runs.
	it('honors legacy subject-keyed subscription and meter rows until the rewrite', async () => {
		const t = initConvexTest();
		const subject = 'user_legacy';
		// startRun-style legacy fixture: users row already adopted the
		// canonical key, but the subscription and meter rows predate the switch.
		await seedUser(t, subject);
		const asUser = t.withIdentity({ subject, email: `${subject}@example.com` });
		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId: subject,
				tier: 'free',
				dodoSubscriptionId: '',
				dodoProductId: '',
				status: 'active',
				eventAt: 1
			});
		});

		// ensure sees the legacy grant and does not create a second row.
		expect((await asUser.query(api.usage.getMyUsage, {})).tier).toBe('free');
		await asUser.mutation(api.billing.ensureMySubscription, {});
		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', subject))
				.collect()
		);
		expect(rows).toHaveLength(1);

		// Meter rows charged under the legacy subject still block the caller
		// under their canonical key, and the usage view shows that overdraft.
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, {
			userId: subject,
			count: 20_000
		});
		const canonicalUserId = subjectTokenIdentifier(subject);
		await expect(
			t.mutation(internal.lib.rateLimits.checkUsageLimits, {
				userId: canonicalUserId
			})
		).rejects.toThrow(/model usage limit reached/);
		const usage = await asUser.query(api.usage.getMyUsage, {});
		expect(usage.exhausted).toBe(true);
		const weekly = usage.meters
			.find((meter) => meter.id === 'modelUsage')
			?.windows.find((window) => window.period === 'weekly');
		expect(weekly && weekly.used > weekly.limit).toBe(true);
	});
});
