import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { initConvexTest, type ConvexTestInstance } from './test.setup';
import {
	drainWebhookJobs,
	sendRawWebhook,
	sendSubscriptionWebhook,
	subscriptionPayload
} from './billingWebhook.test.setup';

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function readSubscription(t: ConvexTestInstance) {
	return t.run((ctx) =>
		ctx.db
			.query('subscriptions')
			.withIndex('by_userId', (q) => q.eq('userId', 'owner'))
			.unique()
	);
}

async function seedTiers(t: ConvexTestInstance, tierIds: string[] = ['pro', 'team']) {
	await t.run(async (ctx) => {
		for (const tierId of tierIds) {
			await ctx.db.insert('tiers', {
				tierId,
				label: tierId,
				weekly: 10,
				monthly: 20,
				monthlyProductId: `prod_${tierId}`
			});
		}
	});
}

async function planChangeFixture() {
	const t = initConvexTest();
	await seedTiers(t);
	const data = subscriptionPayload();
	expect((await sendSubscriptionWebhook(t, 'subscription.active', data)).status).toBe(200);
	await drainWebhookJobs(t);
	await t.mutation(internal.lib.rateLimits.chargeUsageUnits, { userId: 'owner', count: 5 });

	const usage = async () =>
		(
			await t.withIdentity({ subject: 'owner' }).query(api.usage.getMyUsage, {})
		).meters[0]?.windows.map((window) => window.used);

	return { t, data, usage };
}

describe('Dodo webhook ingestion', () => {
	it('rejects an invalid signature before persistence', async () => {
		const t = initConvexTest();

		const body = JSON.stringify({
			type: 'subscription.active',
			timestamp: new Date(Date.now()).toISOString(),
			data: subscriptionPayload()
		});

		const response = await sendRawWebhook(t, body, {
			webhookId: 'wh_forged',
			tamperSignature: true
		});

		expect(response.status).toBe(401);

		const stored = await t.run((ctx) =>
			ctx.db
				.query('dodoWebhookEvents')
				.withIndex('by_environment_and_webhookId', (query) =>
					query.eq('environment', 'test_mode').eq('webhookId', 'wh_forged')
				)
				.unique()
		);

		expect(stored).toBeNull();
	});

	it('rejects requests missing the Standard Webhooks headers', async () => {
		const t = initConvexTest();

		const response = await t.fetch('/dodopayments-webhook', {
			method: 'POST',
			body: '{}'
		});

		expect(response.status).toBe(400);
	});

	it('persists and acknowledges unknown event types without applying them', async () => {
		const t = initConvexTest();

		const response = await sendSubscriptionWebhook(
			t,
			'subscription.paused',
			subscriptionPayload({ status: 'paused' })
		);

		expect(response.status).toBe(200);
		await drainWebhookJobs(t);

		const events = await t.run((ctx) => ctx.db.query('dodoWebhookEvents').collect());
		expect(events).toHaveLength(1);
		expect(events[0]?.eventType).toBe('subscription.paused');
		expect(events[0]?.outcome).toBe('unsupported');
		// Unsupported pause state is durable but compacted: no customer PII.
		expect(events[0]?.payload).not.toContain('owner@example.com');
		expect(await readSubscription(t)).toBeNull();
	});

	it('stores only the allowlisted compact payload, never raw customer details', async () => {
		const t = initConvexTest();
		await seedTiers(t, ['pro']);

		const response = await sendSubscriptionWebhook(t, 'subscription.active', subscriptionPayload());

		expect(response.status).toBe(200);

		const events = await t.run((ctx) => ctx.db.query('dodoWebhookEvents').collect());
		expect(events).toHaveLength(1);
		// The signed body carries the customer's email/name; the durable payload
		// must be the compact allowlisted projection copy without them.
		expect(events[0]?.payload).toBeDefined();
		expect(events[0]?.payload).not.toContain('owner@example.com');
		expect(events[0]?.payload).not.toContain('Owner');
		expect(events[0]?.payload).not.toContain('business_id');
		expect(events[0]?.customerId).toBe('cus_owner');
	});

	it('acknowledges a signed duplicate delivery without reprocessing', async () => {
		const t = initConvexTest();
		await seedTiers(t, ['pro']);

		const body = JSON.stringify({
			business_id: 'business',
			type: 'subscription.active',
			timestamp: new Date(Date.now()).toISOString(),
			data: subscriptionPayload()
		});

		const webhookId = 'wh_redelivered';

		// First delivery, then an exact signed redelivery under the same id.
		for (let delivery = 0; delivery < 2; delivery++) {
			const response = await sendRawWebhook(t, body, { webhookId });
			expect(response.status).toBe(200);
			await drainWebhookJobs(t);
		}

		const events = await t.run((ctx) => ctx.db.query('dodoWebhookEvents').collect());
		const redelivered = events.filter((event) => event.webhookId === webhookId);
		expect(redelivered).toHaveLength(1);
		expect(redelivered[0]?.duplicateCount).toBe(1);
		expect(redelivered[0]?.outcome).toBe('applied');

		// No additional projection write from the duplicate.
		const after = await readSubscription(t);
		expect(after?.projectionRevision).toBe(1);
	});

	it('serializes concurrent signed deliveries of distinct events to one projection', async () => {
		const t = initConvexTest();
		await seedTiers(t, ['pro', 'team']);

		const data = subscriptionPayload();
		const changed = { ...data, product_id: 'prod_team' };
		const eventAt = Date.now() + 1;

		// Distinct webhook-ids, same subscription, delivered concurrently.
		const [first, second] = await Promise.all([
			sendSubscriptionWebhook(t, 'subscription.active', data, Date.now()),
			sendSubscriptionWebhook(t, 'subscription.plan_changed', changed, eventAt)
		]);

		expect([first.status, second.status]).toEqual([200, 200]);
		await drainWebhookJobs(t);

		// Both durably ingested and processed exactly once each.
		const events = await t.run((ctx) => ctx.db.query('dodoWebhookEvents').collect());
		expect(events).toHaveLength(2);
		expect(events.every((event) => event.outcome === 'applied')).toBe(true);

		// The later plan_changed event wins the projection exactly once.
		const subscription = await readSubscription(t);
		expect(subscription?.tier).toBe('team');
		expect(subscription?.eventAt).toBe(eventAt);
	});
});

describe('Dodo subscription webhooks', () => {
	it.each(['remapped', 'removed', 'ambiguous'])(
		'keeps the stored tier on hold after its product assignment is %s',
		async (assignment) => {
			const t = initConvexTest();
			const now = Date.now();
			await t.run(async (ctx) => {
				await ctx.db.insert('subscriptions', {
					userId: 'owner',
					tier: 'team',
					status: 'active',
					eventAt: now - 1_000,
					dodoSubscriptionId: 'sub_owner',
					dodoProductId: 'prod_pro'
				});

				if (assignment !== 'removed') {
					await ctx.db.insert('tiers', {
						tierId: 'max',
						label: 'Max',
						weekly: 1,
						monthly: 1,
						monthlyProductId: 'prod_pro',
						annualProductId: assignment === 'ambiguous' ? 'prod_pro' : undefined
					});
				}
			});

			const response = await sendSubscriptionWebhook(
				t,
				'subscription.updated',
				subscriptionPayload({ status: 'on_hold' }),
				now
			);

			expect(response.status).toBe(200);
			await drainWebhookJobs(t);
			expect(await readSubscription(t)).toMatchObject({
				tier: 'team',
				status: 'on_hold',
				eventAt: now
			});
		}
	);

	it('keeps the confirmed tier and usage when a later status update carries purchase-time metadata', async () => {
		const { t, data, usage } = await planChangeFixture();
		const now = Date.now();
		const changed = { ...data, product_id: 'prod_team' };
		expect(
			(await sendSubscriptionWebhook(t, 'subscription.plan_changed', changed, now + 1)).status
		).toBe(200);
		await drainWebhookJobs(t);
		expect(await readSubscription(t)).toMatchObject({ tier: 'team', quotaResetAt: now + 1 });
		expect(await usage()).toEqual([0, 0]);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, { userId: 'owner', count: 3 });
		expect(
			(await sendSubscriptionWebhook(t, 'subscription.updated', changed, now + 2)).status
		).toBe(200);
		await drainWebhookJobs(t);
		expect(await readSubscription(t)).toMatchObject({ tier: 'team', quotaResetAt: now + 1 });
		expect(await usage()).toEqual([3, 3]);
	});

	it('serializes same-timestamp plan and status deliveries against the current tier', async () => {
		const { t, data } = await planChangeFixture();
		const changed = { ...data, product_id: 'prod_team' };
		const eventAt = Date.now() + 1;

		const responses = await Promise.all([
			sendSubscriptionWebhook(t, 'subscription.plan_changed', changed, eventAt),
			sendSubscriptionWebhook(t, 'subscription.updated', changed, eventAt)
		]);

		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		await drainWebhookJobs(t);
		expect(await readSubscription(t)).toMatchObject({ tier: 'team', eventAt });
	});

	it('applies a scheduled downgrade only at its effective billing boundary', async () => {
		const { t, data, usage } = await planChangeFixture();
		const before = await readSubscription(t);
		const deadline = data.next_billing_date.getTime();

		const scheduled = {
			...data,
			scheduled_change: {
				id: 'change_team',
				effective_at: new Date(deadline),
				product_id: 'prod_team'
			}
		};

		expect(
			(await sendSubscriptionWebhook(t, 'subscription.plan_changed', scheduled, Date.now() + 1))
				.status
		).toBe(200);
		await drainWebhookJobs(t);
		expect(await readSubscription(t)).toMatchObject({
			tier: 'pro',
			quotaResetAt: before?.quotaResetAt
		});
		expect(await usage()).toEqual([5, 5]);
		await vi.advanceTimersByTimeAsync(deadline - Date.now());
		await drainWebhookJobs(t);

		const applied = subscriptionPayload({
			product_id: 'prod_team',
			metadata: data.metadata,
			previous_billing_date: new Date(deadline),
			next_billing_date: new Date(deadline + 60_000)
		});

		expect(
			(await sendSubscriptionWebhook(t, 'subscription.plan_changed', applied, deadline)).status
		).toBe(200);
		await drainWebhookJobs(t);
		expect(await readSubscription(t)).toMatchObject({
			tier: 'team',
			quotaResetAt: deadline,
			billingPeriodEnded: false
		});
		expect(await usage()).toEqual([0, 0]);
	});

	it('resolves a metadata-free status update through the saved customer', async () => {
		const { t, data } = await planChangeFixture();
		expect(
			(
				await sendSubscriptionWebhook(
					t,
					'subscription.updated',
					{ ...data, metadata: {}, status: 'on_hold' },
					Date.now() + 1
				)
			).status
		).toBe(200);
		await drainWebhookJobs(t);
		expect(await readSubscription(t)).toMatchObject({ tier: 'pro', status: 'on_hold' });
	});

	it('uses the reserved purchase tier even after its product is assigned ambiguously', async () => {
		const t = initConvexTest();
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		await t.mutation(internal.billing.reserveCheckoutSession, {
			userId: 'owner',
			attemptId: 'attempt_owner',
			tierId: 'team',
			interval: 'monthly',
			productId: 'prod_pro',
			now: Date.now()
		});
		await t.run((ctx) =>
			ctx.db.insert('tiers', {
				tierId: 'max',
				label: 'Max',
				weekly: 1,
				monthly: 1,
				monthlyProductId: 'prod_pro',
				annualProductId: 'prod_pro'
			})
		);

		const response = await sendSubscriptionWebhook(
			t,
			'subscription.active',
			subscriptionPayload({
				metadata: { userId: 'owner', tierId: 'team', checkoutAttemptId: 'attempt_owner' }
			})
		);

		expect(response.status).toBe(200);
		await drainWebhookJobs(t);
		expect(await readSubscription(t)).toMatchObject({ tier: 'team', status: 'active' });
	});

	it('validates signed account metadata against the saved customer owner', async () => {
		const { t, data } = await planChangeFixture();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const response = await sendSubscriptionWebhook(
			t,
			'subscription.updated',
			{ ...data, metadata: { userId: 'other', tierId: 'pro' }, status: 'on_hold' },
			Date.now() + 1
		);

		expect(response.status).toBe(200);
		// Run the workpool job and its completion callback. The projection throws
		// on the account conflict, so the callback schedules a retry; the event
		// must stay pending rather than commit a partial projection. Do NOT use
		// drainWebhookJobs here: the retry stays pending by design.
		await vi.advanceTimersByTimeAsync(1_000);
		await t.finishInProgressScheduledFunctions();
		await t.finishInProgressScheduledFunctions();

		const event = await t.run((ctx) =>
			ctx.db
				.query('dodoWebhookEvents')
				.withIndex('by_outcome_and_nextAttemptAt', (q) => q.eq('outcome', 'pending'))
				.unique()
		);

		expect(event).toMatchObject({ outcome: 'pending', attempts: 1 });
		expect(await readSubscription(t)).toMatchObject({
			userId: 'owner',
			tier: 'pro',
			status: 'active'
		});
	});
});
