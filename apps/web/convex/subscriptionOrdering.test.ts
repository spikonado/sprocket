import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { initConvexTest, type ConvexTestInstance } from './test.setup';

const UNITS_PER_DOLLAR = 1_000_000_000;

const now = Date.UTC(2026, 5, 15, 12);

const userId = 'user_ordering';

const termStart = now - 60_000;

const termEnd = now + 30 * 86_400_000;

async function seedTiersAndCustomer(t: ConvexTestInstance): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('tiers', {
			tierId: 'free',
			label: 'Free',
			weekly: 5 * UNITS_PER_DOLLAR,
			monthly: 15 * UNITS_PER_DOLLAR
		});
		await ctx.db.insert('tiers', {
			tierId: 'pro',
			label: 'Pro',
			monthlyProductId: 'prod_pro',
			weekly: 25 * UNITS_PER_DOLLAR,
			monthly: 75 * UNITS_PER_DOLLAR
		});
		await ctx.db.insert('tiers', {
			tierId: 'max',
			label: 'Max',
			monthlyProductId: 'prod_max',
			weekly: 170 * UNITS_PER_DOLLAR,
			monthly: 500 * UNITS_PER_DOLLAR
		});
		await ctx.db.insert('billingCustomers', { userId, dodoCustomerId: 'cus_ordering' });
	});
}

type PayloadOverrides = {
	dodoSubscriptionId?: string;
	dodoProductId?: string;
	dodoCustomerId?: string;
	status?: 'active' | 'on_hold' | 'cancelled' | 'expired' | 'failed' | 'past_due';
	eventAt?: number;
	billingInterval?: 'monthly' | 'annual';
	billingPeriodStart?: number;
	billingPeriodEnd?: number;
	cancelAtNextBillingDate?: boolean;
	scheduledChange?: { id: string; productId: string; effectiveAt: number } | null;
};

function webhookArgs(overrides: PayloadOverrides = {}) {
	return {
		userId,
		dodoSubscriptionId: 'sub_1',
		dodoProductId: 'prod_pro',
		dodoCustomerId: 'cus_ordering',
		status: 'active' as const,
		eventAt: now,
		billingInterval: 'monthly' as const,
		billingPeriodStart: termStart,
		billingPeriodEnd: termEnd,
		cancelAtNextBillingDate: false,
		scheduledChange: null,
		...overrides
	};
}

function readSubscription(t: ConvexTestInstance): Promise<Doc<'subscriptions'> | null> {
	return t.run((ctx) =>
		ctx.db
			.query('subscriptions')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique()
	);
}

function observe(
	t: ConvexTestInstance,
	subscription: Doc<'subscriptions'>,
	overrides: PayloadOverrides & { observedAt: number }
) {
	const { observedAt, ...rest } = overrides;

	return t.mutation(internal.subscriptionReconciliation.applyObservation, {
		subscriptionId: subscription._id,
		expectedProjectionRevision: subscription.projectionRevision ?? 0,
		observedAt,
		...webhookArgs(rest),
		eventAt: termStart
	});
}

describe('subscription projection ordering', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(() => vi.useRealTimers());

	it('equal-time conflicting product/term/status/schedule deliveries converge in both orders', async () => {
		// Equal eventAt, opposite tie-break positions on every field.
		const winner = webhookArgs({
			dodoProductId: 'prod_pro',
			status: 'on_hold',
			billingPeriodEnd: termEnd + 86_400_000,
			scheduledChange: { id: 'sch_1', productId: 'prod_max', effectiveAt: now + 86_400_000 }
		});

		const loser = webhookArgs({
			dodoProductId: 'prod_max',
			status: 'active',
			billingPeriodEnd: termEnd,
			scheduledChange: null
		});

		const converge = async (
			first: typeof winner,
			second: typeof winner
		): Promise<Doc<'subscriptions'>> => {
			const t = initConvexTest();
			await seedTiersAndCustomer(t);
			await t.mutation(internal.billing.upsertDodoSubscription, first);
			await t.mutation(internal.billing.upsertDodoSubscription, second);

			const subscription = await readSubscription(t);

			expect(subscription).toMatchObject({
				status: 'on_hold',
				providerStatus: 'on_hold',
				dodoProductId: 'prod_pro',
				billingPeriodEnd: termEnd + 86_400_000,
				scheduledChange: { id: 'sch_1', productId: 'prod_max', effectiveAt: now + 86_400_000 }
			});

			return subscription!;
		};

		const forward = await converge(winner, loser);
		const reverse = await converge(loser, winner);

		expect(forward.quotaGeneration).toBe(1);
		expect(reverse.quotaGeneration).toBe(1);
		expect(reverse).toMatchObject({
			status: forward.status,
			dodoProductId: forward.dodoProductId,
			billingPeriodEnd: forward.billingPeriodEnd,
			quotaGeneration: forward.quotaGeneration
		});
	});

	it('a newer identical payload fences an older contrary redelivery', async () => {
		const t = initConvexTest();
		await seedTiersAndCustomer(t);

		const initial = await t.mutation(internal.billing.upsertDodoSubscription, webhookArgs());
		expect(initial.outcome).toBe('applied');

		// Same effective state at a newer provider event time: watermarks
		// advance, generation does not.
		const renew = await t.mutation(
			internal.billing.upsertDodoSubscription,
			webhookArgs({ eventAt: now + 5_000 })
		);

		expect(renew.outcome).toBe('noop');

		const afterRenew = await readSubscription(t);
		expect(afterRenew).toMatchObject({
			eventAt: now + 5_000,
			payloadEventAt: now + 5_000,
			quotaGeneration: 1
		});

		// A contrary payload stamped between the two is now fenced on every
		// fence: older status/product/term and a losing schedule flag.
		const stale = await t.mutation(
			internal.billing.upsertDodoSubscription,
			webhookArgs({
				eventAt: now + 1_000,
				status: 'on_hold',
				cancelAtNextBillingDate: true,
				billingPeriodStart: termStart - 30 * 86_400_000,
				billingPeriodEnd: termStart
			})
		);

		expect(stale.outcome).toBe('stale');

		const afterStale = await readSubscription(t);
		expect(afterStale).toMatchObject({
			status: 'active',
			eventAt: now + 5_000,
			cancelAtNextBillingDate: false,
			billingPeriodEnd: termEnd,
			quotaGeneration: 1
		});
	});

	it('an observed tier change resets once; a delayed matching webhook never resets twice and keeps provider watermarks', async () => {
		const t = initConvexTest();
		await seedTiersAndCustomer(t);

		await t.mutation(internal.billing.upsertDodoSubscription, webhookArgs());
		const before = (await readSubscription(t))!;
		expect(before.quotaGeneration).toBe(1);

		// The reconciliation observation sees the plan change first.
		const observedAt = now + 60_000;

		const observation = await observe(t, before, {
			observedAt,
			dodoProductId: 'prod_max',
			scheduledChange: null
		});

		expect(observation.outcome).toBe('applied');

		const afterObservation = (await readSubscription(t))!;
		expect(afterObservation).toMatchObject({
			tier: 'max',
			dodoProductId: 'prod_max',
			quotaGeneration: 2,
			quotaTransitionAt: observedAt,
			observedAt,
			// Provider watermarks keep the webhook event time; the observation
			// never stamps its retrieval time into them.
			eventAt: now,
			payloadEventAt: now,
			termEventAt: now
		});

		// The delayed webhook carrying the same plan change must not mint a
		// second generation: the transition identity is already recorded.
		const delayed = await t.mutation(
			internal.billing.upsertDodoSubscription,
			webhookArgs({
				dodoProductId: 'prod_max',
				eventAt: now + 1_000,
				scheduledChange: null
			})
		);

		expect(delayed.outcome).toBe('noop');

		const afterWebhook = (await readSubscription(t))!;
		expect(afterWebhook).toMatchObject({
			tier: 'max',
			quotaGeneration: 2,
			quotaTransitionAt: observedAt,
			// The delayed legitimate webhook still advances the provider
			// watermarks to its own event time.
			eventAt: now + 1_000,
			payloadEventAt: now + 1_000,
			termEventAt: now + 1_000
		});
	});

	it('an on_hold observation ends access without confirming termination', async () => {
		const t = initConvexTest();
		await seedTiersAndCustomer(t);

		await t.mutation(internal.billing.upsertDodoSubscription, webhookArgs());
		const before = (await readSubscription(t))!;

		const observedAt = now + 60_000;

		const observation = await observe(t, before, {
			observedAt,
			status: 'on_hold',
			dodoProductId: 'prod_pro',
			scheduledChange: null
		});

		expect(observation.outcome).toBe('applied');

		const held = (await readSubscription(t))!;
		expect(held).toMatchObject({
			status: 'on_hold',
			providerStatus: 'on_hold',
			accessPhase: 'none',
			terminalConfirmed: false,
			// A status-only observation keeps the confirmed term untouched.
			billingPeriodStart: termStart,
			billingPeriodEnd: termEnd
		});
		expect(held.accessEndsAt).toBeUndefined();

		// No provider terminal event arrived, so a competing purchase is still
		// fenced out even though access has ended.
		const purchase = await t.mutation(
			internal.billing.upsertDodoSubscription,
			webhookArgs({
				dodoSubscriptionId: 'sub_2',
				dodoProductId: 'prod_pro',
				eventAt: now + 120_000
			})
		);

		expect(purchase.outcome).toBe('competing');
	});

	it('a confirmed tier change while held resets once on recovery in either delivery order', async () => {
		for (const reverse of [false, true]) {
			const t = initConvexTest();
			await seedTiersAndCustomer(t);
			await t.mutation(internal.billing.upsertDodoSubscription, webhookArgs());

			const changed = webhookArgs({
				dodoProductId: 'prod_max',
				status: 'on_hold',
				eventAt: now + 1_000
			});

			const active = webhookArgs({ dodoProductId: 'prod_max', eventAt: now + 1_000 });

			for (const event of reverse ? [active, changed] : [changed, active]) {
				await t.mutation(internal.billing.upsertDodoSubscription, event);
			}

			expect(await readSubscription(t)).toMatchObject({
				tier: 'max',
				status: 'on_hold',
				quotaGeneration: 2,
				quotaResetAt: now + 1_000
			});
			await t.mutation(
				internal.billing.upsertDodoSubscription,
				webhookArgs({ dodoProductId: 'prod_max', eventAt: now + 2_000 })
			);
			expect(await readSubscription(t)).toMatchObject({
				tier: 'max',
				status: 'active',
				quotaGeneration: 2,
				quotaResetAt: now + 1_000
			});
		}
	});

	it('a delayed contrary webhook requires retrieval instead of undoing the observed tier', async () => {
		const t = initConvexTest();
		await seedTiersAndCustomer(t);
		await t.mutation(internal.billing.upsertDodoSubscription, webhookArgs());
		await observe(t, (await readSubscription(t))!, {
			observedAt: now + 60_000,
			dodoProductId: 'prod_max'
		});

		const result = await t.mutation(
			internal.billing.upsertDodoSubscription,
			webhookArgs({ eventAt: now + 1_000 })
		);

		expect(result.outcome).toBe('unresolved');
		expect(await readSubscription(t)).toMatchObject({
			tier: 'max',
			quotaGeneration: 2,
			payloadEventAt: now
		});
	});

	it('mandate-creation failure is terminal, but cannot overwrite an established paid identity', async () => {
		const t = initConvexTest();
		await seedTiersAndCustomer(t);
		await t.mutation(internal.billing.upsertDodoSubscription, webhookArgs({ status: 'failed' }));
		expect(await readSubscription(t)).toMatchObject({
			status: 'failed',
			terminalConfirmed: true,
			accessPhase: 'none'
		});
		await t.mutation(
			internal.billing.upsertDodoSubscription,
			webhookArgs({ dodoSubscriptionId: 'sub_2', eventAt: now + 1_000 })
		);

		const result = await t.mutation(
			internal.billing.upsertDodoSubscription,
			webhookArgs({ dodoSubscriptionId: 'sub_2', status: 'failed', eventAt: now + 2_000 })
		);

		expect(result.outcome).toBe('unresolved');
		expect(await readSubscription(t)).toMatchObject({
			dodoSubscriptionId: 'sub_2',
			status: 'active',
			terminalConfirmed: false
		});
	});

	it('a changed product with a mismatched configured interval remains unresolved', async () => {
		const t = initConvexTest();
		await seedTiersAndCustomer(t);

		const result = await t.mutation(
			internal.billing.upsertDodoSubscription,
			webhookArgs({ billingInterval: 'annual' })
		);

		expect(result.outcome).toBe('unresolved');
		expect(await readSubscription(t)).toBeNull();
	});
});
