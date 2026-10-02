import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import { api, internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { initConvexTest, type ConvexTestInstance } from './test.setup';
import { drainWebhookJobs } from './billingWebhook.test.setup';

const UNITS_PER_DOLLAR = 1_000_000_000;

const HOUR = 60 * 60 * 1_000;

const DAY = 24 * HOUR;

const userId = 'user_webhook';

const termStart = Date.UTC(2026, 0, 15, 12);

const termEnd = Date.UTC(2026, 1, 15, 12);

async function seedTiers(t: ConvexTestInstance): Promise<void> {
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
			annualProductId: 'prod_pro_annual',
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
	});
}

type SubscriptionDataOverrides = {
	subscription_id?: string;
	product_id?: string;
	status?: string;
	previous_billing_date?: string;
	next_billing_date?: string;
	cancel_at_next_billing_date?: boolean;
	payment_frequency_count?: number;
	payment_frequency_interval?: string;
	customer?: { customer_id: string };
	metadata?: Record<string, string>;
	scheduled_change?: { id: string; product_id: string; effective_at: string } | null;
};

function subscriptionData(overrides: SubscriptionDataOverrides = {}) {
	return {
		payload_type: 'Subscription',
		subscription_id: 'sub_1',
		product_id: 'prod_pro',
		status: 'active',
		previous_billing_date: new Date(termStart).toISOString(),
		next_billing_date: new Date(termEnd).toISOString(),
		cancel_at_next_billing_date: false,
		payment_frequency_count: 1,
		payment_frequency_interval: 'Month',
		customer: { customer_id: 'cus_1' },
		metadata: { userId, tierId: 'pro', checkoutAttemptId: 'att_1' },
		scheduled_change: null,
		...overrides
	};
}

// The envelope `type`/`timestamp` always agree with the recorded
// `eventType`/`eventAt`; the compact payload persists the same values.
function envelope<T>(eventType: string, eventAt: number, data: T): string {
	return JSON.stringify({
		business_id: 'bus_test',
		type: eventType,
		timestamp: new Date(eventAt).toISOString(),
		data
	});
}

type EventSeed = {
	webhookId: string;
	eventType: string;
	eventAt: number;
	subscriptionId?: string;
	payload: string;
};

async function recordEvent(
	t: ConvexTestInstance,
	seed: EventSeed
): Promise<Id<'dodoWebhookEvents'>> {
	await t.mutation(internal.billingWebhook.recordEvent, {
		environment: 'test_mode',
		webhookId: seed.webhookId,
		eventType: seed.eventType,
		eventAt: seed.eventAt,
		subscriptionId: seed.subscriptionId,
		payload: seed.payload
	});

	const event = await t.run((ctx) =>
		ctx.db
			.query('dodoWebhookEvents')
			.withIndex('by_environment_and_webhookId', (query) =>
				query.eq('environment', 'test_mode').eq('webhookId', seed.webhookId)
			)
			.unique()
	);

	return event!._id;
}

function readSubscription(t: ConvexTestInstance) {
	return t.run((ctx) =>
		ctx.db
			.query('subscriptions')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique()
	);
}

function readEvent(t: ConvexTestInstance, eventId: Id<'dodoWebhookEvents'>) {
	return t.run((ctx) => ctx.db.get('dodoWebhookEvents', eventId));
}

function requireEvent(
	t: ConvexTestInstance,
	eventId: Id<'dodoWebhookEvents'>
): Promise<Doc<'dodoWebhookEvents'>> {
	return t.run(async (ctx) => {
		const event = await ctx.db.get('dodoWebhookEvents', eventId);

		if (!event) throw new Error('event deleted');

		return event;
	});
}

describe('durable webhook ingestion and projection', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(termStart + 60_000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('applies a signed active subscription and schedules a bounded access deadline', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const eventId = await recordEvent(t, {
			webhookId: 'wh_1',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId });

		const subscription = await readSubscription(t);

		expect(subscription?.tier).toBe('pro');
		expect(subscription?.status).toBe('active');
		expect(subscription?.accessPhase).toBe('paid');
		expect(subscription?.accessEndsAt).toBe(termEnd);
		expect(subscription?.projectionRevision).toBe(1);

		const event = await readEvent(t, eventId);
		expect(event?.outcome).toBe('applied');
		expect(event?.attempts).toBe(1);
		expect(event?.workId).toBeDefined();
	});

	it('deduplicates by webhook-id without losing the original outcome', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const payload = envelope('subscription.active', termStart, subscriptionData());

		const first = await recordEvent(t, {
			webhookId: 'wh_dup',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: first });

		// First redelivery bumps the counter but keeps the applied outcome.
		const second = await t.mutation(internal.billingWebhook.recordEvent, {
			environment: 'test_mode',
			webhookId: 'wh_dup',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload
		});

		expect(second.duplicate).toBe(true);

		const event = await readEvent(t, first);
		expect(event?.outcome).toBe('applied');
		expect(event?.duplicateCount).toBe(1);

		// A third redelivery increments again without touching the outcome.
		const third = await t.mutation(internal.billingWebhook.recordEvent, {
			environment: 'test_mode',
			webhookId: 'wh_dup',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload
		});

		expect(third.duplicate).toBe(true);

		const after = await readEvent(t, first);
		expect(after?.outcome).toBe('applied');
		expect(after?.duplicateCount).toBe(2);

		// The stored payload is compacted to the allowlisted projection fields;
		// customer details beyond the id are never persisted.
		expect(after?.payload).toBeDefined();
		expect(after?.payload).not.toContain('owner@example.com');
		expect(after?.payload).not.toContain('business_id');
	});

	it('converges equal-timestamp conflicting statuses deterministically', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		// Deliver failure first, then an equal-time active; terminal wins.
		const failedEvent = await recordEvent(t, {
			webhookId: 'wh_fail',
			eventType: 'subscription.failed',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.failed', termStart, subscriptionData({ status: 'failed' }))
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: failedEvent });

		const activeEvent = await recordEvent(t, {
			webhookId: 'wh_active',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: activeEvent });

		const subscription = await readSubscription(t);
		expect(subscription?.status).toBe('failed');

		const activeOutcome = await readEvent(t, activeEvent);
		expect(activeOutcome?.outcome).toBe('noop');
	});

	it('keeps unsupported pause events durable and observable without granting access', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const eventId = await recordEvent(t, {
			webhookId: 'wh_pause',
			eventType: 'subscription.paused',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.paused', termStart, subscriptionData({ status: 'paused' }))
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId });

		const event = await readEvent(t, eventId);
		expect(event?.outcome).toBe('unsupported');

		const subscription = await readSubscription(t);
		expect(subscription).toBeNull();
	});

	it('keeps an unknown subscription status durable, compact, and replayable after repair', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		// A provider status we do not recognize. The compact payload must drop
		// the unparsable data but keep type/timestamp so the event stays
		// observable, and a repaired schema can still process it on replay.
		const rawData = {
			...subscriptionData({ status: 'suspended_future_state' }),
			customer: { customer_id: 'cus_1', email: 'owner@example.com', name: 'Owner' }
		};

		const eventId = await recordEvent(t, {
			webhookId: 'wh_future_status',
			eventType: 'subscription.updated',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.updated', termStart, rawData)
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId });

		const event = await requireEvent(t, eventId);
		expect(event.outcome).toBe('unsupported');
		// Compact payload: customer email/name stripped, but the allowlisted
		// subscription fields (including the unknown status) are preserved so
		// the event stays durable and replayable after a repair.
		expect(event.payload).toBeDefined();
		expect(event.payload).not.toContain('owner@example.com');
		expect(event.payload).not.toContain('Owner');
		expect(event.payload).toContain('suspended_future_state');
		expect(event.payload).toContain('sub_1');
		expect(await readSubscription(t)).toBeNull();

		// Observable via the problem lookup.
		const problems = await t.query(internal.billingWebhook.listProblemEvents, {});
		expect(problems.some((problem) => problem.eventId === eventId)).toBe(true);

		// After a repair that maps the product, replay re-parses the retained
		// payload; the unknown status is still gated as unsupported (never
		// applied) but the event stays replayable rather than dropped.
		await t.mutation(internal.billingWebhook.replayEvent, { eventId });
		const replayed = await requireEvent(t, eventId);
		expect(replayed.outcome).toBe('pending');
		expect(replayed.attempts).toBe(0);
	});

	it('fences a superseded identity so its events cannot reclaim the projection', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		// Establish subscription sub_1, then terminate it, then a new purchase sub_2.
		const sub1 = await recordEvent(t, {
			webhookId: 'wh_sub1',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: sub1 });

		const cancel1 = await recordEvent(t, {
			webhookId: 'wh_cancel1',
			eventType: 'subscription.cancelled',
			eventAt: termStart + 1_000,
			subscriptionId: 'sub_1',
			payload: envelope(
				'subscription.cancelled',
				termStart + 1_000,
				subscriptionData({ status: 'cancelled', cancel_at_next_billing_date: false })
			)
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: cancel1 });

		const sub2 = await recordEvent(t, {
			webhookId: 'wh_sub2',
			eventType: 'subscription.active',
			eventAt: termStart + 2_000,
			subscriptionId: 'sub_2',
			payload: envelope(
				'subscription.active',
				termStart + 2_000,
				subscriptionData({
					subscription_id: 'sub_2',
					product_id: 'prod_max',
					metadata: { userId, tierId: 'max', checkoutAttemptId: 'att_2' }
				})
			)
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: sub2 });

		let subscription = await readSubscription(t);
		expect(subscription?.dodoSubscriptionId).toBe('sub_2');
		expect(subscription?.tier).toBe('max');

		// A late event for superseded sub_1 must not reclaim the projection.
		const late = await recordEvent(t, {
			webhookId: 'wh_late',
			eventType: 'subscription.updated',
			eventAt: termStart + 3_000,
			subscriptionId: 'sub_1',
			payload: envelope(
				'subscription.updated',
				termStart + 3_000,
				subscriptionData({ status: 'active' })
			)
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: late });

		subscription = await readSubscription(t);
		expect(subscription?.dodoSubscriptionId).toBe('sub_2');

		const lateEvent = await readEvent(t, late);
		expect(lateEvent?.outcome).toBe('stale');
	});

	it('resets both windows for distinct equal-time plan transitions without resetting on replay', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run((ctx) =>
			ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				weekly: 25 * UNITS_PER_DOLLAR,
				monthly: 75 * UNITS_PER_DOLLAR,
				monthlyProductId: 'prod_team'
			})
		);
		const owner = t.withIdentity({ subject: userId });

		const usage = async () =>
			(await owner.query(api.usage.getMyUsage, {})).meters[0]!.windows.map((window) => window.used);

		const project = async (productId: string) => {
			const eventId = await recordEvent(t, {
				webhookId: crypto.randomUUID(),
				eventType: 'subscription.plan_changed',
				eventAt: termStart,
				payload: envelope(
					'subscription.plan_changed',
					termStart,
					subscriptionData({ product_id: productId })
				)
			});

			await t.mutation(internal.billingWebhook.processEvent, { eventId });
		};

		await project('prod_max');

		for (const productId of ['prod_pro', 'prod_team']) {
			const previousUsage = await usage();
			await t.mutation(internal.lib.rateLimits.chargeUsageUnits, { userId, count: 5 });
			expect(await usage()).toEqual(previousUsage.map((used) => used + 5));
			const before = await readSubscription(t);
			await project(productId);
			expect(await usage()).toEqual([0, 0]);
			expect((await readSubscription(t))?.quotaGeneration).toBe(before!.quotaGeneration! + 1);
			await t.mutation(internal.lib.rateLimits.chargeUsageUnits, { userId, count: 3 });
			await project(productId);
			expect(await usage()).toEqual([3, 3]);
		}
	});

	it('resets usage generation exactly once for an effective tier change', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const sub = await recordEvent(t, {
			webhookId: 'wh_a',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: sub });

		const before = await readSubscription(t);
		expect(before?.quotaResetAt).toBe(termStart);

		// Plan change to max at a later event time resets the generation.
		const change = await recordEvent(t, {
			webhookId: 'wh_change',
			eventType: 'subscription.plan_changed',
			eventAt: termStart + 5_000,
			subscriptionId: 'sub_1',
			payload: envelope(
				'subscription.plan_changed',
				termStart + 5_000,
				subscriptionData({
					product_id: 'prod_max',
					metadata: { userId, tierId: 'max', checkoutAttemptId: 'att_x' }
				})
			)
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: change });

		const after = await readSubscription(t);
		expect(after?.tier).toBe('max');
		expect(after?.quotaResetAt).toBe(termStart + 5_000);

		// A duplicate replay of the same change does not grant a fresh generation.
		const replay = await recordEvent(t, {
			webhookId: 'wh_change2',
			eventType: 'subscription.plan_changed',
			eventAt: termStart + 5_000,
			subscriptionId: 'sub_1',
			payload: envelope(
				'subscription.plan_changed',
				termStart + 5_000,
				subscriptionData({
					product_id: 'prod_max',
					metadata: { userId, tierId: 'max', checkoutAttemptId: 'att_x' }
				})
			)
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: replay });

		const final = await readSubscription(t);
		expect(final?.quotaResetAt).toBe(termStart + 5_000);
	});

	it('enters renewal-processing grace at term end and ends access at the one-hour deadline', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const sub = await recordEvent(t, {
			webhookId: 'wh_g',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: sub });

		// Advance to just past the term end; the expiry check flips to grace.
		vi.setSystemTime(termEnd + 1_000);

		await t.mutation(internal.subscriptionExpiry.checkSubscriptionExpiry, {
			subscriptionId: (await readSubscription(t))!._id,
			dodoSubscriptionId: 'sub_1',
			billingPeriodEnd: termEnd,
			projectionRevision: 1,
			expectedPhase: 'paid'
		});

		let subscription = await readSubscription(t);
		expect(subscription?.accessPhase).toBe('renewal_processing');
		expect(subscription?.accessEndsAt).toBe(termEnd + HOUR);

		// A stale scheduler that fires after the grace deadline must not extend
		// access past it: enforcement re-checks the wall clock via accessEndsAt.
		vi.setSystemTime(termEnd + HOUR + 1);

		subscription = await readSubscription(t);
		expect(subscription?.accessPhase).toBe('renewal_processing');
	});

	it('resolves a changed product through the tier mapping, not stale metadata', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const sub = await recordEvent(t, {
			webhookId: 'wh_map1',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: sub });

		// Plan change payload with WRONG metadata tierId but a mapped product.
		const change = await recordEvent(t, {
			webhookId: 'wh_map2',
			eventType: 'subscription.plan_changed',
			eventAt: termStart + 5_000,
			subscriptionId: 'sub_1',
			payload: envelope(
				'subscription.plan_changed',
				termStart + 5_000,
				subscriptionData({
					product_id: 'prod_max',
					metadata: { userId, tierId: 'pro', checkoutAttemptId: 'att_x' }
				})
			)
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId: change });

		const subscription = await readSubscription(t);
		// The changed product resolves via the product→tier mapping (prod_max→max),
		// not the stale 'pro' metadata tier id.
		expect(subscription?.tier).toBe('max');
	});

	it('retains unresolved product transitions for repair instead of advancing', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const eventId = await recordEvent(t, {
			webhookId: 'wh_unknown',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope(
				'subscription.active',
				termStart,
				subscriptionData({
					product_id: 'prod_unknown',
					metadata: { userId, checkoutAttemptId: 'att_u' }
				})
			)
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId });

		const event = await readEvent(t, eventId);
		expect(event?.outcome).toBe('unresolved');

		// No projection is written for an unresolved product.
		const subscription = await readSubscription(t);
		expect(subscription).toBeNull();

		// After repair (mapping the product), replay applies it.
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'repaired',
				label: 'Repaired',
				monthlyProductId: 'prod_unknown',
				weekly: 1,
				monthly: 2
			});
		});

		await t.mutation(internal.billingWebhook.replayEvent, { eventId });

		// Replay enqueues the worker through the workpool; let it run.
		await drainWebhookJobs(t);

		const repaired = await readSubscription(t);
		expect(repaired?.tier).toBe('repaired');

		const replayed = await readEvent(t, eventId);
		expect(replayed?.outcome).toBe('applied');
	});

	it('keeps unknown event types durable and observable without applying them', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const eventId = await recordEvent(t, {
			webhookId: 'wh_unknown_type',
			eventType: 'payment.succeeded',
			eventAt: termStart,
			payload: envelope('payment.succeeded', termStart, { payment_id: 'pay_1' })
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId });

		const event = await readEvent(t, eventId);
		expect(event?.outcome).toBe('unsupported');
		expect(event?.eventType).toBe('payment.succeeded');

		const problems = await t.query(internal.billingWebhook.listProblemEvents, {});
		expect(problems.some((problem) => problem.eventId === eventId)).toBe(true);
	});

	it('retries a failed projection with bounded backoff until exhaustion', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		// A zero-length term makes the projection upsert throw after validation.
		// Modify the data field (next_billing_date), not the envelope.
		const broken = subscriptionData({
			previous_billing_date: new Date(termStart).toISOString(),
			next_billing_date: new Date(termStart).toISOString()
		});

		const eventId = await recordEvent(t, {
			webhookId: 'wh_broken',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, broken)
		});

		for (let attempt = 1; attempt <= 5; attempt++) {
			await expect(t.mutation(internal.billingWebhook.processEvent, { eventId })).rejects.toThrow(
				'positive duration'
			);

			// The completion callback is fenced on the event's actual workId.
			const current = await requireEvent(t, eventId);

			await t.mutation(internal.billingWebhook.completeProcessing, {
				// SAFETY: recordEvent populated the field from workpool enqueue.
				workId: current.workId as WorkId,
				context: { eventId },
				result: { kind: 'failed', error: 'Dodo billing period must have a positive duration.' }
			});

			const event = await requireEvent(t, eventId);
			expect(event.attempts).toBe(attempt);

			if (attempt < 5) {
				// Bounded backoff is scheduled; the ledger stays pending for retry.
				expect(event.outcome).toBe('pending');
				expect(event.nextAttemptAt).toBeGreaterThan(Date.now());
				expect(event.outcomeDetail).toBe('Processing failed; retry scheduled.');
			}
		}

		const exhausted = await requireEvent(t, eventId);
		expect(exhausted.outcome).toBe('failed');
		expect(exhausted.nextAttemptAt).toBeUndefined();

		// No partial projection committed beside the failed ledger outcomes.
		expect(await readSubscription(t)).toBeNull();
	});

	it('ignores a completion callback for a stale workId', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const broken = subscriptionData({
			previous_billing_date: new Date(termStart).toISOString(),
			next_billing_date: new Date(termStart).toISOString()
		});

		const eventId = await recordEvent(t, {
			webhookId: 'wh_fence',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, broken)
		});

		await expect(t.mutation(internal.billingWebhook.processEvent, { eventId })).rejects.toThrow(
			'positive duration'
		);

		// A callback carrying an invented (stale) workId must be ignored: the
		// fence keeps an old completion from clobbering the current retry state.
		await t.mutation(internal.billingWebhook.completeProcessing, {
			// SAFETY: deliberately fabricated branded id exercises the stale fence.
			workId: 'work_stale_invented' as WorkId,
			context: { eventId },
			result: { kind: 'failed', error: 'stale' }
		});

		const event = await requireEvent(t, eventId);
		expect(event.attempts).toBe(0);
		expect(event.outcome).toBe('pending');
	});

	it('pump re-enqueues a pending event whose scheduled retry was lost', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		// Record and fully drain a healthy event so its workpool job reaches a
		// finished state in the component, yielding a real finished workId.
		const eventId = await recordEvent(t, {
			webhookId: 'wh_pump',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		await drainWebhookJobs(t);

		const finished = await requireEvent(t, eventId);
		expect(finished.outcome).toBe('applied');
		expect(finished.workId).toBeDefined();

		// Simulate a lost retry: the ledger is back to pending with a due backoff,
		// but its recorded workId points at the already-finished workpool job.
		// The pump's status fence sees 'finished' and re-enqueues rather than
		// trusting the stale workId.
		await t.run((ctx) =>
			ctx.db.patch('dodoWebhookEvents', eventId, {
				outcome: 'pending',
				attempts: 1,
				nextAttemptAt: Date.now() - 1_000
			})
		);

		await t.mutation(internal.billingWebhook.retryPending, {});

		const event = await requireEvent(t, eventId);
		// The pump re-enqueued with a fresh workId distinct from the finished one;
		// still pending until the workpool runs it.
		expect(event.workId).toBeDefined();
		expect(event.workId).not.toBe(finished.workId);
		expect(event.outcome).toBe('pending');
	});

	it('pump leaves a pending event alone while its workpool job is still live', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const eventId = await recordEvent(t, {
			webhookId: 'wh_live',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		// Backoff is due, but the recorded workId is the live job the workpool
		// has not started yet (still pending in the component), so the fence
		// holds and the pump must not double-enqueue.
		const live = await requireEvent(t, eventId);
		await t.run((ctx) =>
			ctx.db.patch('dodoWebhookEvents', eventId, { nextAttemptAt: Date.now() - 1_000 })
		);

		await t.mutation(internal.billingWebhook.retryPending, {});

		const after = await requireEvent(t, eventId);
		expect(after.workId).toBe(live.workId);
	});

	it('cleanup prunes payloads but preserves compact identity and outcome for dedup', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const payload = envelope('subscription.active', termStart, subscriptionData());

		const eventId = await recordEvent(t, {
			webhookId: 'wh_old',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId });

		// Past the 48h payload horizon but inside the 14d dedup horizon.
		vi.setSystemTime(termStart + 3 * DAY);
		await t.mutation(internal.billingWebhook.cleanupEvents, {});

		const pruned = await requireEvent(t, eventId);
		expect(pruned.payload).toBeUndefined();
		expect(pruned.outcome).toBe('applied');

		// Dedup still works from the preserved identity row.
		const redelivery = await t.mutation(internal.billingWebhook.recordEvent, {
			environment: 'test_mode',
			webhookId: 'wh_old',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload
		});

		expect(redelivery.duplicate).toBe(true);

		// Past the 14d dedup horizon, the compact row itself is removed.
		vi.setSystemTime(termStart + 15 * DAY);
		await t.mutation(internal.billingWebhook.cleanupEvents, {});

		expect(await readEvent(t, eventId)).toBeNull();
	});

	it('cleanup preserves pending and problem payloads through the replay horizon', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const eventIds: Id<'dodoWebhookEvents'>[] = [];

		for (const outcome of [
			'pending',
			'failed',
			'unresolved',
			'competing',
			'unsupported'
		] as const) {
			const eventId = await recordEvent(t, {
				webhookId: `wh_retained_${outcome}`,
				eventType: 'subscription.active',
				eventAt: termStart,
				payload: envelope('subscription.active', termStart, subscriptionData())
			});

			await t.run((ctx) => ctx.db.patch('dodoWebhookEvents', eventId, { outcome }));
			eventIds.push(eventId);
		}

		vi.setSystemTime(termStart + 3 * DAY);
		await t.mutation(internal.billingWebhook.cleanupEvents, {});

		for (const eventId of eventIds) expect((await requireEvent(t, eventId)).payload).toBeDefined();
		await expect(
			t.mutation(internal.billingWebhook.processEvent, { eventId: eventIds[0]! })
		).resolves.toBe('applied');
		vi.setSystemTime(termStart + 15 * DAY);
		await t.mutation(internal.billingWebhook.cleanupEvents, {});

		for (const eventId of eventIds) expect(await readEvent(t, eventId)).toBeNull();
	});

	it('cleanup automatically scans beyond one batch and revisits newly aged rows next run', async () => {
		const t = initConvexTest();

		const now = Date.now();
		const agedReceivedAt = now - 20 * DAY;

		// 55 fresh rows fill more than the first cleanup batch (50).
		for (let index = 0; index < 55; index++) {
			await recordEvent(t, {
				webhookId: `wh_fresh_${index}`,
				eventType: 'subscription.active',
				eventAt: termStart,
				subscriptionId: `sub_fresh_${index}`,
				payload: envelope('subscription.active', termStart, subscriptionData())
			});
		}

		// One aged row (past the dedup horizon) lands AFTER the fresh rows in
		// ingestion order, so the first batch of 50 never reaches it.
		const oldId = await recordEvent(t, {
			webhookId: 'wh_cursor_old',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_old',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		await t.run((ctx) => ctx.db.patch('dodoWebhookEvents', oldId, { receivedAt: agedReceivedAt }));

		// First run scans the 50 fresh rows, skips them (all fresh), and advances
		// the cursor past them without touching the aged tail row (seq 55, beyond
		// the first batch of seq 0-49).
		await t.mutation(internal.billingWebhook.cleanupEvents, {});
		expect(await readEvent(t, oldId)).not.toBeNull();

		let cursor = await t.run((ctx) =>
			ctx.db
				.query('dodoWebhookCleanup')
				.withIndex('by_key', (query) => query.eq('key', 'cleanup'))
				.unique()
		);

		expect(cursor?.cursor).toBe(49);

		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(await readEvent(t, oldId)).toBeNull();

		cursor = await t.run((ctx) =>
			ctx.db
				.query('dodoWebhookCleanup')
				.withIndex('by_key', (query) => query.eq('key', 'cleanup'))
				.unique()
		);
		expect(cursor?.cursor).toBe(55);
		vi.setSystemTime(now + 15 * DAY);
		await t.mutation(internal.billingWebhook.cleanupEvents, {});
		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.query('dodoWebhookEvents').collect())).toEqual([]);
	});
});
