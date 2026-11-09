import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import {
	initConvexTest,
	insertUser,
	seedTiers,
	sendDodoWebhook as sendWebhook,
	stubDodoEnv,
	type ConvexTestInstance
} from './test.setup';

const DAY = 86_400_000;

type DodoSubscription = {
	subscription_id: string;
	product_id: string;
	status: string;
	previous_billing_date: string;
	next_billing_date: string;
	cancel_at_next_billing_date: boolean;
	customer: { customer_id: string };
	metadata: Record<string, string>;
};

function dodoSubscription(overrides: Partial<DodoSubscription> = {}): DodoSubscription {
	const now = Date.now();

	return {
		subscription_id: 'sub_owner',
		product_id: 'prod_pro',
		status: 'active',
		previous_billing_date: new Date(now - 60_000).toISOString(),
		next_billing_date: new Date(now + 30 * DAY).toISOString(),
		cancel_at_next_billing_date: false,
		customer: { customer_id: 'cus_owner' },
		metadata: {},
		...overrides
	};
}

function stubDodo(subscriptions: DodoSubscription[]) {
	stubDodoEnv();
	const requests: URL[] = [];

	vi.stubGlobal('fetch', async (input: Request | string | URL) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		requests.push(url);

		if (url.pathname === '/subscriptions') {
			const customerId = url.searchParams.get('customer_id');

			return Response.json({
				items: subscriptions.filter((item) => item.customer.customer_id === customerId)
			});
		}

		const found = subscriptions.find(
			(item) => url.pathname === `/subscriptions/${item.subscription_id}`
		);

		return found ? Response.json(found) : Response.json({ message: 'Not found' }, { status: 404 });
	});

	return requests;
}

function readMirror(t: ConvexTestInstance) {
	return t.run((ctx) => ctx.db.query('subscriptions').collect());
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('Dodo subscription mirror', () => {
	it('fetches the subscription a signed webhook names and mirrors it for the linked customer', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run((ctx) => insertUser(ctx, 'owner', 'cus_owner'));
		const subscription = dodoSubscription();
		const requests = stubDodo([subscription]);

		const response = await sendWebhook(t, 'subscription.renewed', {
			subscription_id: 'sub_owner',
			status: 'stale payload'
		});

		expect(response.status).toBe(204);
		expect(requests.map((url) => url.pathname)).toEqual(['/subscriptions/sub_owner']);
		expect(await readMirror(t)).toMatchObject([
			{
				userId: 'owner',
				dodoSubscriptionId: 'sub_owner',
				dodoProductId: 'prod_pro',
				status: 'active',
				billingPeriodStart: Date.parse(subscription.previous_billing_date),
				billingPeriodEnd: Date.parse(subscription.next_billing_date),
				cancelAtNextBillingDate: false,
				syncedAt: Date.now()
			}
		]);
		await expect(
			t.withIdentity({ subject: 'owner' }).query(api.billing.getMySubscription, {})
		).resolves.toMatchObject({ tier: 'pro', billingManaged: true, accessPhase: 'active' });
	});

	it('links a new customer through the checkout userId metadata', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run((ctx) => insertUser(ctx, 'owner'));
		stubDodo([dodoSubscription({ metadata: { userId: 'owner' } })]);

		expect(
			(await sendWebhook(t, 'subscription.active', { subscription_id: 'sub_owner' })).status
		).toBe(204);
		await expect(
			t.query(internal.billingCustomers.getDodoCustomerId, { userId: 'owner' })
		).resolves.toBe('cus_owner');
		expect(await readMirror(t)).toMatchObject([{ userId: 'owner' }]);
	});

	it('acknowledges events for unknown customers and other event types without mirroring', async () => {
		const t = initConvexTest();
		const requests = stubDodo([dodoSubscription()]);

		expect(
			(await sendWebhook(t, 'subscription.active', { subscription_id: 'sub_owner' })).status
		).toBe(204);
		expect((await sendWebhook(t, 'license_key.created', {})).status).toBe(204);
		expect(requests).toHaveLength(1);
		expect(await readMirror(t)).toEqual([]);
	});

	it('rejects a bad signature before calling Dodo', async () => {
		const t = initConvexTest();
		const requests = stubDodo([dodoSubscription()]);

		const response = await sendWebhook(
			t,
			'subscription.active',
			{ subscription_id: 'sub_owner' },
			{ tamper: true }
		);

		expect(response.status).toBe(401);
		expect(requests).toEqual([]);
	});

	it('fails the delivery so Dodo redelivers when the subscription lookup fails', async () => {
		const t = initConvexTest();
		stubDodo([]);

		await expect(
			sendWebhook(t, 'subscription.active', { subscription_id: 'sub_owner' })
		).rejects.toThrow('404');
	});

	it('keeps the newer mirror when an older fetch lands late', async () => {
		const t = initConvexTest();
		await t.run((ctx) => insertUser(ctx, 'owner', 'cus_owner'));

		const sync = (fetchedAt: number, status: 'active' | 'cancelled') =>
			t.mutation(internal.subscriptions.sync, {
				fetchedAt,
				dodoCustomerId: 'cus_owner',
				subscription: {
					dodoSubscriptionId: 'sub_owner',
					dodoProductId: 'prod_pro',
					status,
					billingPeriodStart: 0,
					billingPeriodEnd: DAY,
					cancelAtNextBillingDate: false
				}
			});

		await sync(2, 'cancelled');
		await sync(1, 'active');

		expect(await readMirror(t)).toMatchObject([{ status: 'cancelled', syncedAt: 2 }]);
	});

	it('resyncs active subscriptions whose period ended without a renewal webhook', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		const now = Date.now();
		await t.run(async (ctx) => {
			await insertUser(ctx, 'owner', 'cus_owner');
			await ctx.db.insert('subscriptions', {
				userId: 'owner',
				dodoSubscriptionId: 'sub_owner',
				dodoProductId: 'prod_pro',
				status: 'active',
				billingPeriodStart: now - 31 * DAY,
				billingPeriodEnd: now - DAY,
				cancelAtNextBillingDate: false,
				syncedAt: now - 31 * DAY
			});
		});
		stubDodo([dodoSubscription({ previous_billing_date: new Date(now - DAY).toISOString() })]);

		expect(
			await t.withIdentity({ subject: 'owner' }).query(api.usage.getMyUsage, { now })
		).toMatchObject({
			tier: 'free'
		});
		await t.action(internal.dodo.syncOverdue, {});
		expect(
			await t.withIdentity({ subject: 'owner' }).query(api.usage.getMyUsage, { now })
		).toMatchObject({
			tier: 'pro'
		});
	});

	it('resyncs every Dodo customer and reports users the old ledger may have double-charged', async () => {
		const t = initConvexTest();
		await seedTiers(t);
		await t.run(async (ctx) => {
			await insertUser(ctx, 'owner', 'cus_owner');
			await insertUser(ctx, 'free_user');
			await ctx.db.insert('dodoWebhookEvents', {
				seq: 1,
				environment: 'test_mode',
				webhookId: 'webhook_competing',
				eventType: 'subscription.active',
				receivedAt: 1,
				subscriptionId: 'sub_second',
				payload: JSON.stringify({ data: { metadata: { userId: 'owner' } } }),
				attempts: 1,
				outcome: 'competing'
			});
		});
		stubDodo([
			dodoSubscription(),
			dodoSubscription({ subscription_id: 'sub_second', product_id: 'prod_max' })
		]);

		await t.mutation(internal.migrations.run, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await readMirror(t)).toHaveLength(2);
		await expect(t.query(internal.billingAudit.listDoubleCharges, {})).resolves.toEqual({
			rejectedEvents: [
				{
					webhookId: 'webhook_competing',
					eventType: 'subscription.active',
					outcome: 'competing',
					receivedAt: 1,
					dodoSubscriptionId: 'sub_second',
					user: { subject: 'owner', email: 'owner@example.com' }
				}
			],
			usersWithSeveralLiveSubscriptions: [
				{
					userId: 'owner',
					email: 'owner@example.com',
					dodoSubscriptionIds: ['sub_owner', 'sub_second']
				}
			]
		});

		await t.mutation(internal.billingAudit.deleteWebhookEvents, {});
		expect(await t.run((ctx) => ctx.db.query('dodoWebhookEvents').collect())).toEqual([]);
	});
});
