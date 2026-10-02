import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { FunctionArgs } from 'convex/server';
import type { Id } from '@convex/_generated/dataModel';
import { gatewayQuotaStatus } from '@convex/lib/rateLimits';
import { initConvexTest, type ConvexTestInstance } from './test.setup';

const now = Date.UTC(2026, 5, 15, 12);

const deadline = now + 60_000;

const HOUR = 60 * 60 * 1_000;

const userId = 'user_expiry';

function paidSubscription(
	overrides: Partial<FunctionArgs<typeof internal.billing.upsertDodoSubscription>> = {}
) {
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
		cancelAtNextBillingDate: false,
		...overrides
	};
}

async function seedTiers(t: ConvexTestInstance): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('tiers', { tierId: 'free', label: 'Free', weekly: 5, monthly: 15 });
		// The product mapping is required: the projection resolves the initial
		// product through the unique tier/interval mapping when no checkout
		// reservation or unchanged-product tier applies.
		await ctx.db.insert('tiers', {
			tierId: 'pro',
			label: 'Pro',
			weekly: 25,
			monthly: 75,
			monthlyProductId: 'prod_pro'
		});
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

describe('subscription access phase boundaries', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(() => vi.useRealTimers());

	it('materializes paid access with the term-end deadline', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const asUser = t.withIdentity({ subject: args.userId });

		expect(await asUser.query(api.billing.getMySubscription, {})).toMatchObject({ tier: 'pro' });

		const subscription = await readSubscription(t);
		expect(subscription).toMatchObject({
			accessPhase: 'paid',
			accessEndsAt: deadline,
			projectionRevision: 1
		});
		expect(subscription?.billingPeriodCheckId).toBeDefined();
	});

	it('a confirmed future term opens paid access at its start and chains the term-end check', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const futureStart = now + HOUR;
		const futureEnd = futureStart + 60_000;

		await t.mutation(internal.billing.upsertDodoSubscription, {
			userId,
			tier: 'pro',
			dodoSubscriptionId: 'sub_future',
			dodoProductId: 'prod_pro',
			dodoCustomerId: 'cus_expiry',
			status: 'active',
			eventAt: now,
			billingInterval: 'monthly',
			billingPeriodStart: futureStart,
			billingPeriodEnd: futureEnd,
			cancelAtNextBillingDate: false
		});

		// Before the term starts there is no paid access, but the start
		// boundary has a pending check.
		let subscription = await readSubscription(t);
		expect(subscription).toMatchObject({ accessPhase: 'none', accessEndsAt: futureStart });
		const startCheckId = subscription?.billingPeriodCheckId;

		if (!startCheckId) throw new Error('Missing term-start check.');

		const asUser = t.withIdentity({ subject: userId });
		expect(await asUser.query(api.billing.getMySubscription, {})).toMatchObject({ tier: 'free' });

		// At the start boundary, access opens and the term-end check chains.
		vi.setSystemTime(futureStart + 1);
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, userId))).toMatchObject({ tier: 'pro' });
		await expect(
			t.mutation(internal.lib.rateLimits.chargeUsageUnits, { userId, count: 1 })
		).resolves.toBeNull();
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: 'sub_future',
			billingPeriodEnd: futureEnd,
			projectionRevision: subscription!.projectionRevision ?? 0,
			expectedPhase: 'none'
		});

		subscription = await readSubscription(t);
		expect(subscription).toMatchObject({ accessPhase: 'paid', accessEndsAt: futureEnd });
		const endCheckId = subscription?.billingPeriodCheckId;

		if (!endCheckId) throw new Error('Missing term-end check.');
		expect(endCheckId).not.toBe(startCheckId);
		expect(await readCheck(t, endCheckId)).toMatchObject({
			state: { kind: 'pending' },
			scheduledTime: futureEnd
		});

		expect(await asUser.query(api.billing.getMySubscription, {})).toMatchObject({ tier: 'pro' });

		// At the term end the chained check advances into renewal grace.
		vi.setSystemTime(futureEnd + 1);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: 'sub_future',
			billingPeriodEnd: futureEnd,
			projectionRevision: subscription!.projectionRevision ?? 0,
			expectedPhase: 'paid'
		});

		subscription = await readSubscription(t);
		expect(subscription).toMatchObject({
			accessPhase: 'renewal_processing',
			accessEndsAt: futureEnd + HOUR
		});
	});

	it('enters renewal-processing grace at the term end and keeps the prior allowance', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);

		const subscription = await readSubscription(t);
		const checkId = subscription?.billingPeriodCheckId;

		if (!checkId) throw new Error('Missing expiry check.');

		// Advance to just past the term end and run the scheduled boundary check.
		vi.setSystemTime(deadline + 1_000);

		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: 1,
			expectedPhase: 'paid'
		});

		const grace = await readSubscription(t);
		expect(grace).toMatchObject({
			accessPhase: 'renewal_processing',
			accessEndsAt: deadline + HOUR
		});

		// Paid access continues during grace; usage stays on the preserved bucket.
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, args.userId))).toMatchObject({
			tier: 'pro'
		});

		void checkId;
	});

	it('ends access exactly at the one-hour grace deadline', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const subscription = await readSubscription(t);

		vi.setSystemTime(deadline + 1_000);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: 1,
			expectedPhase: 'paid'
		});

		// Advance past the grace deadline and run the follow-up boundary check.
		vi.setSystemTime(deadline + HOUR + 1);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: 1,
			expectedPhase: 'renewal_processing'
		});

		const ended = await readSubscription(t);
		expect(ended?.accessPhase).toBe('none');

		const asUser = t.withIdentity({ subject: args.userId });
		expect(await asUser.query(api.billing.getMySubscription, {})).toMatchObject({
			tier: 'free'
		});
	});

	it('a delayed scheduler cannot extend access past the materialized deadline', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const subscription = await readSubscription(t);

		vi.setSystemTime(deadline + 1_000);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: 1,
			expectedPhase: 'paid'
		});

		// The materialized phase still says renewal_processing after the deadline
		// because the follow-up scheduler has not run; enforcement re-checks the
		// wall-clock deadline and reports no access.
		vi.setSystemTime(deadline + HOUR + 5_000);
		const stale = await readSubscription(t);
		expect(stale?.accessPhase).toBe('renewal_processing');
		expect(stale?.accessEndsAt).toBe(deadline + HOUR);

		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, args.userId))).toMatchObject({
			tier: 'free'
		});
	});

	it('a delayed scheduler still gets the full bounded grace and never more', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);

		// No boundary check runs: the materialized row still says paid with the
		// term-end deadline. Enforcement re-derives the bounded grace window
		// from the confirmed term end.
		const subscription = await readSubscription(t);
		expect(subscription).toMatchObject({ accessPhase: 'paid', accessEndsAt: deadline });

		// Inside the grace hour, enforcement reports renewal-processing access
		// even though the scheduler never materialized it.
		vi.setSystemTime(deadline + HOUR / 2);
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, args.userId))).toMatchObject({
			tier: 'pro'
		});

		// Exactly at the grace deadline, access ends regardless of the stale
		// materialized paid phase.
		vi.setSystemTime(deadline + HOUR);
		expect(await t.run((ctx) => gatewayQuotaStatus(ctx, args.userId))).toMatchObject({
			tier: 'free'
		});
	});

	it('grace ends access without confirming termination; repurchase stays blocked', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const subscription = await readSubscription(t);

		// Exhaust the grace window through the boundary checks.
		vi.setSystemTime(deadline + 1_000);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: 1,
			expectedPhase: 'paid'
		});
		vi.setSystemTime(deadline + HOUR + 1);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: 1,
			expectedPhase: 'renewal_processing'
		});

		const ended = await readSubscription(t);
		// Local grace exhaustion is not authoritative termination: the row must
		// not become repurchasable without a provider terminal event.
		expect(ended?.accessPhase).toBe('none');
		expect(ended?.terminalConfirmed).toBe(false);

		// A new purchase event for a different Dodo subscription is still
		// competing: the current identity was never provider-terminated.
		const takeover = await t.mutation(internal.billing.upsertDodoSubscription, {
			userId: args.userId,
			dodoSubscriptionId: 'sub_new_purchase',
			dodoProductId: 'prod_pro',
			dodoCustomerId: 'cus_expiry',
			status: 'active',
			eventAt: deadline + HOUR + 2,
			billingInterval: 'monthly',
			billingPeriodStart: deadline + HOUR + 2,
			billingPeriodEnd: deadline + HOUR + 2 + 30 * 86_400_000,
			cancelAtNextBillingDate: false
		});

		expect(takeover.outcome).toBe('competing');

		// A provider-confirmed terminal event releases the identity.
		const terminal = await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			status: 'expired',
			eventAt: deadline + HOUR + 3
		});

		expect(terminal.outcome).toBe('applied');

		const repurchase = await t.mutation(internal.billing.upsertDodoSubscription, {
			userId: args.userId,
			dodoSubscriptionId: 'sub_new_purchase',
			dodoProductId: 'prod_pro',
			dodoCustomerId: 'cus_expiry',
			status: 'active',
			eventAt: deadline + HOUR + 4,
			billingInterval: 'monthly',
			billingPeriodStart: deadline + HOUR + 4,
			billingPeriodEnd: deadline + HOUR + 4 + 30 * 86_400_000,
			cancelAtNextBillingDate: false
		});

		expect(repurchase.outcome).toBe('applied');
	});

	it('ends access immediately on a confirmed failed renewal with no grace', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);

		await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			status: 'on_hold',
			eventAt: now + 1_000
		});

		const subscription = await readSubscription(t);
		expect(subscription).toMatchObject({ status: 'on_hold', accessPhase: 'none' });

		const asUser = t.withIdentity({ subject: args.userId });
		expect(await asUser.query(api.billing.getMySubscription, {})).toMatchObject({
			tier: 'free'
		});
	});

	it('scheduled cancellation keeps access to the deadline and gets no renewal grace', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);

		await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			status: 'cancelled',
			cancelAtNextBillingDate: true,
			eventAt: now + 1_000
		});

		// Still active until the effective deadline.
		let subscription = await readSubscription(t);
		expect(subscription).toMatchObject({
			status: 'active',
			accessPhase: 'paid',
			accessEndsAt: deadline,
			cancelAtNextBillingDate: true
		});

		// At the deadline there is no renewal grace.
		vi.setSystemTime(deadline + 1);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: subscription!.projectionRevision ?? 0,
			expectedPhase: 'paid'
		});

		subscription = await readSubscription(t);
		expect(subscription?.accessPhase).toBe('none');
	});

	it('a stale scheduled check for a superseded revision is a no-op', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const first = await readSubscription(t);

		const firstCheckId = first?.billingPeriodCheckId;

		if (!firstCheckId) throw new Error('Missing scheduled expiry.');

		// Renew with a later event and term; the projection revision advances and
		// the old check is superseded.
		vi.setSystemTime(deadline);
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			eventAt: now + 1,
			billingPeriodStart: deadline,
			billingPeriodEnd: deadline + 60_000
		});

		const renewed = await readSubscription(t);
		expect(renewed?.billingPeriodCheckId).not.toBe(firstCheckId);
		expect(await readCheck(t, firstCheckId)).toMatchObject({ state: { kind: 'canceled' } });

		// Firing the old fenced check must not change the newer projection.
		vi.setSystemTime(deadline + 1);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: first!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: 1,
			expectedPhase: 'paid'
		});

		expect(await readSubscription(t)).toMatchObject({
			billingPeriodEnd: deadline + 60_000,
			accessPhase: 'paid'
		});
	});

	it('a historical failed renewal does not override a newer confirmed term', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);

		// Confirm a newer term.
		vi.setSystemTime(deadline);
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			eventAt: now + 5_000,
			billingPeriodStart: deadline,
			billingPeriodEnd: deadline + 60_000
		});

		// A delayed failure for the older term must not close the current one.
		await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			status: 'on_hold',
			eventAt: now + 1_000
		});

		const subscription = await readSubscription(t);
		expect(subscription).toMatchObject({ status: 'active', accessPhase: 'paid' });
	});

	it('preserves operator grants that have no Dodo subscription id', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId,
				tier: 'pro',
				status: 'active',
				eventAt: now
			});
		});

		// A provider event must not overwrite the operator grant.
		const result = await t.mutation(internal.billing.upsertDodoSubscription, {
			userId,
			dodoSubscriptionId: 'sub_new',
			dodoProductId: 'prod_pro',
			dodoCustomerId: 'cus_other',
			status: 'active',
			eventAt: now + 1_000,
			billingInterval: 'monthly',
			billingPeriodStart: now,
			billingPeriodEnd: deadline,
			cancelAtNextBillingDate: false
		});

		expect(result.outcome).toBe('competing');

		const subscription = await readSubscription(t);
		expect(subscription?.dodoSubscriptionId).toBeUndefined();
	});

	it('an applied observation never fences out a delayed webhook stamped later', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const before = await readSubscription(t);

		// A reconciliation observation retrieved after the webhook applies:
		// it confirms the same term and must not move any provider watermark.
		const observedAt = now + 60_000;

		const observation = await t.mutation(internal.subscriptionReconciliation.applyObservation, {
			subscriptionId: before!._id,
			expectedProjectionRevision: before!.projectionRevision ?? 1,
			dodoSubscriptionId: args.dodoSubscriptionId,
			dodoProductId: args.dodoProductId,
			dodoCustomerId: 'cus_expiry',
			status: 'active',
			eventAt: args.billingPeriodStart,
			observedAt,
			billingInterval: 'monthly',
			billingPeriodStart: args.billingPeriodStart,
			billingPeriodEnd: args.billingPeriodEnd,
			cancelAtNextBillingDate: false,
			scheduledChange: null
		});

		expect(observation.outcome).toBe('noop');

		const afterObservation = await readSubscription(t);
		expect(afterObservation).toMatchObject({
			eventAt: now,
			payloadEventAt: now,
			termEventAt: now,
			observedAt
		});

		// A delayed legitimate webhook stamped after the original confirmation
		// (but before the observation's retrieval) still applies and renews.
		const delayed = await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			eventAt: now + 5_000,
			billingPeriodStart: args.billingPeriodEnd,
			billingPeriodEnd: args.billingPeriodEnd + 30 * 86_400_000
		});

		expect(delayed.outcome).toBe('applied');

		const renewed = await readSubscription(t);
		expect(renewed).toMatchObject({
			eventAt: now + 5_000,
			payloadEventAt: now + 5_000,
			termEventAt: now + 5_000,
			billingPeriodEnd: args.billingPeriodEnd + 30 * 86_400_000
		});
	});

	it('a winning status preserves the newer product and term of a losing payload', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);

		// A payload at the same position with a losing product is fenced on
		// the payload side but wins the status side; the stored product/term
		// must survive.
		const result = await t.mutation(internal.billing.upsertDodoSubscription, {
			...args,
			status: 'on_hold',
			dodoProductId: 'prod_a_older',
			eventAt: now,
			billingPeriodStart: args.billingPeriodStart,
			billingPeriodEnd: args.billingPeriodEnd
		});

		expect(result.outcome).toBe('applied');

		const subscription = await readSubscription(t);
		expect(subscription).toMatchObject({
			status: 'on_hold',
			dodoProductId: 'prod_pro',
			billingPeriodStart: args.billingPeriodStart,
			billingPeriodEnd: args.billingPeriodEnd
		});
	});
});

describe('subscription reconciliation queueing', () => {
	it('coalesces concurrent starts and records exhaustion for protected operator replay', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const subscription = (await readSubscription(t))!;

		const job = {
			subscriptionId: subscription._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			projectionRevision: subscription.projectionRevision ?? 0,
			force: true
		};

		await Promise.all([
			t.mutation(internal.subscriptionReconciliation.queueReconciliation, job),
			t.mutation(internal.subscriptionReconciliation.queueReconciliation, job)
		]);
		const records = await t.run((ctx) => ctx.db.query('subscriptionReconciliations').collect());
		expect(records).toHaveLength(1);
		const pending = records[0]!;
		await t.mutation(internal.subscriptionReconciliation.completeReconciliation, {
			// SAFETY: the record stores the id returned by workpool enqueue.
			workId: pending.workId as import('@convex-dev/workpool').WorkId,
			context: { subscriptionId: subscription._id },
			result: { kind: 'failed', error: 'transient' }
		});
		expect(
			await t.query(internal.subscriptionReconciliation.getReconciliation, {
				subscriptionId: subscription._id
			})
		).toMatchObject({ state: 'exhausted', workId: pending.workId });
		await t.mutation(internal.subscriptionReconciliation.queueReconciliation, job);
		expect(
			await t.query(internal.subscriptionReconciliation.getReconciliation, {
				subscriptionId: subscription._id
			})
		).toMatchObject({ state: 'exhausted', workId: pending.workId });
		await t.mutation(internal.subscriptionReconciliation.queueReconciliation, {
			...job,
			replay: true
		});

		const replay = await t.query(internal.subscriptionReconciliation.getReconciliation, {
			subscriptionId: subscription._id
		});

		expect(replay?.state).toBe('pending');
		expect(replay?.workId).not.toBe(pending.workId);
	});

	it('an unresolved observation remains exhausted even while the previous plan is paid', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const subscription = (await readSubscription(t))!;

		await t.mutation(internal.subscriptionReconciliation.queueReconciliation, {
			subscriptionId: subscription._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			projectionRevision: subscription.projectionRevision ?? 0,
			force: true
		});

		const pending = (await t.query(internal.subscriptionReconciliation.getReconciliation, {
			subscriptionId: subscription._id
		}))!;

		await t.mutation(internal.subscriptionReconciliation.completeReconciliation, {
			// SAFETY: the record stores the id returned by workpool enqueue.
			workId: pending.workId as import('@convex-dev/workpool').WorkId,
			context: { subscriptionId: subscription._id },
			result: {
				kind: 'success',
				returnValue: { outcome: 'blocked', detail: 'Observation unresolved.' }
			}
		});

		expect(
			await t.query(internal.subscriptionReconciliation.getReconciliation, {
				subscriptionId: subscription._id
			})
		).toMatchObject({ state: 'exhausted' });
	});
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(() => vi.useRealTimers());

	it('queueReconciliation accepts the forced single-shot contract the projection sends', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const subscription = await readSubscription(t);

		// The projection queues forced retrievals with `force: true`; the
		// queue mutation must accept the argument (Convex rejects undeclared
		// args) and enqueue without throwing.
		await t.mutation(internal.subscriptionReconciliation.queueReconciliation, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			projectionRevision: subscription!.projectionRevision ?? 0,
			force: true
		});

		// A bounded chain step carries its attempt counter through the queue.
		await t.mutation(internal.subscriptionReconciliation.queueReconciliation, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			projectionRevision: subscription!.projectionRevision ?? 0,
			attempt: 2
		});
	});

	it('an observation for a revision that advanced during retrieval is rejected as stale', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);
		const subscription = await readSubscription(t);

		const stale = await t.mutation(internal.subscriptionReconciliation.applyObservation, {
			subscriptionId: subscription!._id,
			expectedProjectionRevision: (subscription!.projectionRevision ?? 1) + 1,
			dodoSubscriptionId: args.dodoSubscriptionId,
			dodoProductId: args.dodoProductId,
			dodoCustomerId: 'cus_expiry',
			status: 'active',
			eventAt: args.billingPeriodStart,
			observedAt: now + 1_000,
			billingInterval: 'monthly',
			billingPeriodStart: args.billingPeriodStart,
			billingPeriodEnd: args.billingPeriodEnd,
			cancelAtNextBillingDate: false,
			scheduledChange: null
		});

		expect(stale.outcome).toBe('stale');
	});

	it('a provider-terminal observation stops recovery and frees the identity', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const args = await upsertPaidSubscription(t);

		// Exhaust the grace window through the boundary checks so the row is
		// access-none and recovery reconciliation is active.
		const subscription = await readSubscription(t);
		vi.setSystemTime(deadline + 1_000);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: 1,
			expectedPhase: 'paid'
		});
		vi.setSystemTime(deadline + HOUR + 1);
		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: subscription!._id,
			dodoSubscriptionId: args.dodoSubscriptionId,
			billingPeriodEnd: deadline,
			projectionRevision: 1,
			expectedPhase: 'renewal_processing'
		});

		const ended = await readSubscription(t);
		expect(ended).toMatchObject({ accessPhase: 'none', terminalConfirmed: false });

		// A recovery observation confirming provider expiry applies through
		// the projection path and marks the identity terminal.
		const observed = await t.mutation(internal.subscriptionReconciliation.applyObservation, {
			subscriptionId: ended!._id,
			expectedProjectionRevision: ended!.projectionRevision ?? 1,
			dodoSubscriptionId: args.dodoSubscriptionId,
			dodoProductId: args.dodoProductId,
			dodoCustomerId: 'cus_expiry',
			status: 'expired',
			eventAt: args.billingPeriodStart,
			observedAt: deadline + HOUR + 2_000,
			billingInterval: 'monthly',
			billingPeriodStart: args.billingPeriodStart,
			billingPeriodEnd: args.billingPeriodEnd,
			cancelAtNextBillingDate: false,
			scheduledChange: null
		});

		expect(observed.outcome).toBe('applied');

		const terminal = await readSubscription(t);
		expect(terminal).toMatchObject({
			status: 'expired',
			terminalConfirmed: true,
			accessPhase: 'none'
		});

		// The terminal identity no longer blocks a new purchase.
		const repurchase = await t.mutation(internal.billing.upsertDodoSubscription, {
			userId: args.userId,
			dodoSubscriptionId: 'sub_after_recovery',
			dodoProductId: 'prod_pro',
			dodoCustomerId: 'cus_expiry',
			status: 'active',
			eventAt: deadline + HOUR + 3_000,
			billingInterval: 'monthly',
			billingPeriodStart: deadline + HOUR + 3_000,
			billingPeriodEnd: deadline + HOUR + 3_000 + 30 * 86_400_000,
			cancelAtNextBillingDate: false
		});

		expect(repurchase.outcome).toBe('applied');
	});
});
