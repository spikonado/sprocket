import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runToCompletion } from '@convex-dev/migrations';
import { api, components, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { gatewayQuotaStatus } from '@convex/lib/rateLimits';
import { initConvexTest, type ConvexTestInstance } from './test.setup';

const now = Date.UTC(2026, 5, 15, 12);

const deadline = now + 60_000;

const userId = 'user_expiry';

function paidSubscription() {
	return {
		userId,
		tier: 'pro',
		dodoSubscriptionId: 'sub_expiry',
		dodoProductId: 'prod_pro',
		dodoCustomerId: 'cus_expiry',
		status: 'active' as const,
		eventAt: now,
		billingInterval: 'monthly' as const,
		billingPeriodStart: now - 60_000,
		billingPeriodEnd: deadline,
		cancelAtNextBillingDate: false
	};
}

async function seedTiers(t: ConvexTestInstance): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('tiers', { tierId: 'free', label: 'Free', weekly: 5, monthly: 15 });
		await ctx.db.insert('tiers', { tierId: 'pro', label: 'Pro', weekly: 25, monthly: 75 });
	});
}

function readSubscription(t: ConvexTestInstance) {
	return t.run((ctx) =>
		ctx.db
			.query('subscriptions')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique()
	);
}

function readCheck(t: ConvexTestInstance, checkId: Id<'_scheduled_functions'>) {
	return t.run((ctx) => ctx.db.system.get('_scheduled_functions', checkId));
}

async function upsertPaidSubscription(t: ConvexTestInstance) {
	const args = paidSubscription();

	await t.mutation(internal.billing.upsertDodoSubscription, args);

	return args;
}

describe('Dodo subscription period boundary', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});
	afterEach(() => vi.useRealTimers());

	it('writes the ended period at its deadline and keeps billing management available', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const asUser = t.withIdentity({ subject: args.userId });
		const before = await readSubscription(t);

		expect(await asUser.query(api.billing.getMySubscription, {})).toMatchObject({ tier: 'pro' });
		expect(await asUser.query(api.usage.getMyUsage, {})).toMatchObject({ tier: 'pro' });
		await vi.advanceTimersByTimeAsync(59_999);
		expect(await readSubscription(t)).toEqual(before);
		await vi.advanceTimersByTimeAsync(1);
		await t.finishInProgressScheduledFunctions();
		expect(await readSubscription(t)).toMatchObject({
			status: 'active',
			eventAt: args.eventAt,
			billingPeriodEnded: true
		});
		expect(await readSubscription(t)).not.toHaveProperty('billingPeriodCheckId');
		expect(await asUser.query(api.billing.getMySubscription, {})).toMatchObject({
			tier: 'free',
			billingManaged: true
		});
		const usage = await asUser.query(api.usage.getMyUsage, {});

		expect(usage).toMatchObject({ tier: 'free' });
		expect(usage.meters[0]?.windows[1]).toMatchObject({
			limit: 15,
			resetsAt: Date.UTC(2026, 6, 1)
		});
	});

	it('enforces Free quotas when the scheduled update has not run yet', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, { userId: args.userId, count: 6 });
		vi.setSystemTime(deadline);
		expect(await readSubscription(t)).toMatchObject({ billingPeriodEnded: false });
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, args.userId))).toMatchObject({
			tier: 'free',
			exhausted: true
		});
	});

	it('reuses duplicate deadlines and replaces them on renewal without accepting an old check', async () => {
		const t = initConvexTest();
		const args = await upsertPaidSubscription(t);
		const first = await readSubscription(t);

		const firstCheckId = first?.billingPeriodCheckId;

		if (!firstCheckId) throw new Error('Missing scheduled expiry.');
		await t.mutation(internal.billing.upsertDodoSubscription, args);
		expect(await readSubscription(t)).toEqual(first);
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			eventAt: now + 1,
			billingPeriodStart: deadline,
			billingPeriodEnd: deadline + 60_000
		});
		const renewed = await readSubscription(t);

		expect(renewed?.billingPeriodCheckId).not.toBe(firstCheckId);
		expect(await readCheck(t, firstCheckId)).toMatchObject({
			state: { kind: 'canceled' }
		});
		await vi.advanceTimersByTimeAsync(60_000);
		await t.finishInProgressScheduledFunctions();
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: first._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline
		});
		expect(await readSubscription(t)).toEqual(renewed);
		await vi.advanceTimersByTimeAsync(60_000);
		await t.finishInProgressScheduledFunctions();
		expect(await readSubscription(t)).toMatchObject({ billingPeriodEnded: true });
	});

	it('restores paid access on a delayed renewal even at the previous event timestamp', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		await vi.advanceTimersByTimeAsync(60_000);
		await t.finishInProgressScheduledFunctions();
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			billingPeriodStart: deadline,
			billingPeriodEnd: deadline + 60_000
		});
		expect(await readSubscription(t)).toMatchObject({
			status: 'active',
			billingPeriodEnded: false
		});
		expect(
			await t.withIdentity({ subject: args.userId }).query(api.billing.getMySubscription, {})
		).toMatchObject({ tier: 'pro' });
	});

	it('schedules annual deadlines without shortening the paid term', async () => {
		const t = initConvexTest();
		const annualEnd = Date.UTC(2027, 5, 15, 12);
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...paidSubscription(),
			billingInterval: 'annual',
			billingPeriodStart: now,
			billingPeriodEnd: annualEnd
		});
		const subscription = await readSubscription(t);

		const checkId = subscription?.billingPeriodCheckId;

		if (!checkId) throw new Error('Missing annual expiry.');
		expect(await readCheck(t, checkId)).toMatchObject({
			scheduledTime: annualEnd,
			state: { kind: 'pending' }
		});
		// convex-test uses setTimeout, which cannot represent a full year's delay.
		vi.setSystemTime(annualEnd);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription._id,
			dodoSubscriptionId: subscription.dodoSubscriptionId!,
			billingPeriodEnd: annualEnd
		});
		expect(await readSubscription(t)).toMatchObject({ billingPeriodEnded: true });
	});

	it('backfills existing managed periods and preserves operator grants', async () => {
		const t = initConvexTest();

		const subscription = {
			userId,
			tier: 'pro',
			status: 'active' as const,
			eventAt: now,
			dodoSubscriptionId: 'sub_existing',
			billingPeriodEnd: deadline
		};

		const ids = await t.run(async (ctx) => {
			const active = await ctx.db.insert('subscriptions', subscription);

			const elapsed = await ctx.db.insert('subscriptions', {
				...subscription,
				userId: 'elapsed',
				billingPeriodStart: now - 120_000,
				billingPeriodEnd: now - 1
			});

			const grant = await ctx.db.insert('subscriptions', {
				userId: 'operator',
				tier: 'pro',
				status: 'active',
				eventAt: now
			});

			return { active, elapsed, grant };
		});

		const grant = await t.run((ctx) => ctx.db.get('subscriptions', ids.grant));
		await t.run((ctx) =>
			runToCompletion(ctx, components.migrations, internal.migrations.backfillSubscriptionExpiry)
		);
		const active = await t.run((ctx) => ctx.db.get('subscriptions', ids.active));

		expect(active).toMatchObject({
			billingPeriodEnded: false,
			billingPeriodCheckId: expect.any(String)
		});
		expect(await t.run((ctx) => ctx.db.get('subscriptions', ids.elapsed))).toMatchObject({
			billingPeriodEnded: true
		});
		expect(await t.run((ctx) => ctx.db.get('subscriptions', ids.grant))).toEqual(grant);
		await vi.advanceTimersByTimeAsync(60_000);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.get('subscriptions', ids.active))).toMatchObject({
			billingPeriodEnded: true
		});
	});
});
