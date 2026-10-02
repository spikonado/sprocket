import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { initConvexTest, type ConvexTestInstance } from './test.setup';
import { sendSubscriptionWebhook, subscriptionPayload } from './billingWebhook.test.setup';

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

async function planChangeFixture() {
	const t = initConvexTest();
	await t.run(async (ctx) => {
		for (const tierId of ['pro', 'team']) {
			await ctx.db.insert('tiers', {
				tierId,
				label: tierId,
				weekly: 10,
				monthly: 20,
				monthlyProductId: `prod_${tierId}`
			});
		}
	});
	const data = subscriptionPayload();
	expect((await sendSubscriptionWebhook(t, 'subscription.active', data)).status).toBe(200);
	await t.mutation(internal.lib.rateLimits.chargeUsageUnits, { userId: 'owner', count: 5 });

	const usage = async () =>
		(
			await t.withIdentity({ subject: 'owner' }).query(api.usage.getMyUsage, {})
		).meters[0]?.windows.map((window) => window.used);

	return { t, data, usage };
}

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
		expect(await readSubscription(t)).toMatchObject({ tier: 'team', quotaResetAt: now + 1 });
		expect(await usage()).toEqual([0, 0]);
		await t.mutation(internal.lib.rateLimits.chargeUsageUnits, { userId: 'owner', count: 3 });
		expect(
			(await sendSubscriptionWebhook(t, 'subscription.updated', changed, now + 2)).status
		).toBe(200);
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
				addons: [],
				created_at: new Date(),
				effective_at: new Date(deadline),
				product_id: 'prod_team',
				quantity: 1
			}
		};

		expect(
			(await sendSubscriptionWebhook(t, 'subscription.plan_changed', scheduled, Date.now() + 1))
				.status
		).toBe(200);
		expect(await readSubscription(t)).toMatchObject({
			tier: 'pro',
			quotaResetAt: before?.quotaResetAt
		});
		expect(await usage()).toEqual([5, 5]);
		await vi.advanceTimersByTimeAsync(deadline - Date.now());
		await t.finishInProgressScheduledFunctions();

		const applied = subscriptionPayload({
			product_id: 'prod_team',
			metadata: data.metadata,
			previous_billing_date: new Date(deadline),
			next_billing_date: new Date(deadline + 60_000)
		});

		expect(
			(await sendSubscriptionWebhook(t, 'subscription.plan_changed', applied, deadline)).status
		).toBe(200);
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
		expect(await readSubscription(t)).toMatchObject({ tier: 'pro', status: 'on_hold' });
	});

	it('uses the reserved purchase tier even after its product is assigned ambiguously', async () => {
		const t = initConvexTest();
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

		expect(response.status).toBe(400);
		expect(await readSubscription(t)).toMatchObject({
			userId: 'owner',
			tier: 'pro',
			status: 'active'
		});
	});
});
