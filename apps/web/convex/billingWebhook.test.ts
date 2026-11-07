import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import { chargeUsage } from '@convex/lib/quota';
import { CLEANUP_BATCH_SIZE, MAX_ATTEMPTS } from './billingWebhook';
import {
	fixtureWorkId,
	initConvexTest,
	seedTiers,
	tickPastLastCommit,
	type ConvexTestInstance
} from './test.setup';
import { drainWebhookJobs } from './billingWebhook.test.setup';

const HOUR = 60 * 60 * 1_000;

const DAY = 24 * HOUR;

const userId = 'user_webhook';

const termStart = Date.UTC(2026, 0, 15, 12);

const termEnd = Date.UTC(2026, 1, 15, 12);

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

		expect(after?.payload).toBeDefined();
		expect(after?.payload).not.toContain('owner@example.com');
		expect(after?.payload).not.toContain('business_id');
	});

	it('converges equal-timestamp conflicting statuses deterministically', async () => {
		const t = initConvexTest();
		await seedTiers(t);

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
		expect(event.payload).toBeDefined();
		expect(event.payload).not.toContain('owner@example.com');
		expect(event.payload).not.toContain('Owner');
		expect(event.payload).toContain('suspended_future_state');
		expect(event.payload).toContain('sub_1');
		expect(await readSubscription(t)).toBeNull();

		const problems = await t.query(internal.billingWebhook.listProblemEvents, {});
		expect(problems.some((problem) => problem.eventId === eventId)).toBe(true);

		await t.mutation(internal.billingWebhook.replayEvent, { eventId });
		const replayed = await requireEvent(t, eventId);
		expect(replayed.outcome).toBe('pending');
		expect(replayed.attempts).toBe(0);
	});

	it('fences a superseded identity so its events cannot reclaim the projection', async () => {
		const t = initConvexTest();
		await seedTiers(t);

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

	it('resets usage for distinct equal-time plan transitions without resetting on replay', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run((ctx) =>
			ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				monthly: 75 * MODEL_USAGE_UNITS_PER_DOLLAR,
				monthlyProductId: 'prod_team'
			})
		);
		const owner = t.withIdentity({ subject: userId });

		const usage = async () =>
			(await owner.query(api.usage.getMyUsage, { now: Date.now() })).meters[0]!.used;

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
			await t.run((ctx) => chargeUsage(ctx, userId, 5));
			expect(await usage()).toBe(previousUsage + 5);
			const before = await readSubscription(t);
			await project(productId);
			expect(await usage()).toBe(0);
			expect((await readSubscription(t))?.quotaResetAt).toBe(before!.quotaResetAt! + 1);
			await t.run((ctx) => chargeUsage(ctx, userId, 3));
			await project(productId);
			expect(await usage()).toBe(3);
		}
	});

	it('resets usage exactly once for an effective tier change', async () => {
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

		const subscription = await readSubscription(t);
		expect(subscription).toBeNull();

		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'repaired',
				label: 'Repaired',
				monthlyProductId: 'prod_unknown',
				monthly: 2
			});
		});

		await t.mutation(internal.billingWebhook.replayEvent, { eventId });

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

	it('keeps the removed update_payment_method event durable but unsupported', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const eventId = await recordEvent(t, {
			webhookId: 'wh_update_pm',
			eventType: 'subscription.update_payment_method',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.update_payment_method', termStart, subscriptionData())
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId });

		const event = await readEvent(t, eventId);
		expect(event?.outcome).toBe('unsupported');

		expect(await readSubscription(t)).toBeNull();
	});

	it('maps a past_due event onto on_hold access', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const eventId = await recordEvent(t, {
			webhookId: 'wh_past_due',
			eventType: 'subscription.past_due',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope(
				'subscription.past_due',
				termStart,
				subscriptionData({ status: 'past_due' })
			)
		});

		await t.mutation(internal.billingWebhook.processEvent, { eventId });

		const event = await readEvent(t, eventId);
		expect(event?.outcome).toBe('applied');

		const subscription = await readSubscription(t);
		expect(subscription?.status).toBe('on_hold');
	});

	it('retries a failed projection with bounded backoff until exhaustion', async () => {
		const t = initConvexTest();
		await seedTiers(t);

		const zeroLengthTerm = subscriptionData({
			previous_billing_date: new Date(termStart).toISOString(),
			next_billing_date: new Date(termStart).toISOString()
		});

		const eventId = await recordEvent(t, {
			webhookId: 'wh_broken',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload: envelope('subscription.active', termStart, zeroLengthTerm)
		});

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			await expect(t.mutation(internal.billingWebhook.processEvent, { eventId })).rejects.toThrow(
				'positive duration'
			);

			const current = await requireEvent(t, eventId);

			await t.mutation(internal.billingWebhook.completeProcessing, {
				workId: current.workId!,
				context: { eventId },
				result: { kind: 'failed', error: 'Dodo billing period must have a positive duration.' }
			});

			const event = await requireEvent(t, eventId);
			expect(event.attempts).toBe(attempt);

			if (attempt < MAX_ATTEMPTS) {
				expect(event.outcome).toBe('pending');
				expect(event.nextAttemptAt).toBeGreaterThan(Date.now());
				expect(event.outcomeDetail).toBe('Processing failed; retry scheduled.');
			}
		}

		const exhausted = await requireEvent(t, eventId);
		expect(exhausted.outcome).toBe('failed');
		expect(exhausted.nextAttemptAt).toBeUndefined();

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

		await t.mutation(internal.billingWebhook.completeProcessing, {
			workId: fixtureWorkId('work_stale_invented'),
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

		await t.run((ctx) =>
			ctx.db.patch('dodoWebhookEvents', eventId, {
				outcome: 'pending',
				attempts: 1,
				nextAttemptAt: Date.now() - 1_000
			})
		);

		await t.mutation(internal.billingWebhook.retryPending, {});

		const event = await requireEvent(t, eventId);
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

		vi.setSystemTime(termStart + 3 * DAY);
		await t.mutation(internal.billingWebhook.cleanupEvents, {});

		const pruned = await requireEvent(t, eventId);
		expect(pruned.payload).toBeUndefined();
		expect(pruned.outcome).toBe('applied');

		const redelivery = await t.mutation(internal.billingWebhook.recordEvent, {
			environment: 'test_mode',
			webhookId: 'wh_old',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_1',
			payload
		});

		expect(redelivery.duplicate).toBe(true);

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

		for (let index = 0; index < CLEANUP_BATCH_SIZE + 5; index++) {
			await recordEvent(t, {
				webhookId: `wh_fresh_${index}`,
				eventType: 'subscription.active',
				eventAt: termStart,
				subscriptionId: `sub_fresh_${index}`,
				payload: envelope('subscription.active', termStart, subscriptionData())
			});
		}

		const agedTailId = await recordEvent(t, {
			webhookId: 'wh_cursor_old',
			eventType: 'subscription.active',
			eventAt: termStart,
			subscriptionId: 'sub_old',
			payload: envelope('subscription.active', termStart, subscriptionData())
		});

		await t.run((ctx) =>
			ctx.db.patch('dodoWebhookEvents', agedTailId, { receivedAt: agedReceivedAt })
		);

		tickPastLastCommit();
		await t.mutation(internal.billingWebhook.cleanupEvents, {});
		expect(await readEvent(t, agedTailId)).not.toBeNull();

		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(await readEvent(t, agedTailId)).toBeNull();

		vi.setSystemTime(now + 15 * DAY);
		await t.mutation(internal.billingWebhook.cleanupEvents, {});
		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.query('dodoWebhookEvents').collect())).toEqual([]);
	});
});
