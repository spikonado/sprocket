import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Subscription } from 'dodopayments/resources/subscriptions';
import { initConvexTest, type ConvexTestInstance } from './test.setup';

const now = Date.UTC(2026, 5, 15, 12);

const RENEWAL_GRACE_MS = 60 * 60 * 1_000;

const termStart = now - 30 * 86_400_000 - RENEWAL_GRACE_MS;

const termEnd = now - RENEWAL_GRACE_MS;

const userId = 'user_reconciliation';

async function seed(t: ConvexTestInstance): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('tiers', { tierId: 'free', label: 'Free', weekly: 5, monthly: 15 });
		await ctx.db.insert('tiers', {
			tierId: 'pro',
			label: 'Pro',
			weekly: 25,
			monthly: 75,
			monthlyProductId: 'prod_pro'
		});
		await ctx.db.insert('billingCustomers', { userId, dodoCustomerId: 'cus_reconciliation' });
		await ctx.db.insert('subscriptions', {
			userId,
			tier: 'pro',
			status: 'active',
			eventAt: now,
			projectionRevision: 1,
			dodoSubscriptionId: 'sub_reconciliation',
			dodoProductId: 'prod_pro',
			billingInterval: 'monthly',
			billingPeriodStart: termStart,
			billingPeriodEnd: termEnd,
			cancelAtNextBillingDate: false,
			accessPhase: 'renewal_processing',
			accessEndsAt: termEnd,
			terminalConfirmed: false
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

type ProviderSubscription = Pick<
	Subscription,
	| 'subscription_id'
	| 'product_id'
	| 'status'
	| 'previous_billing_date'
	| 'next_billing_date'
	| 'cancel_at_next_billing_date'
	| 'payment_frequency_count'
	| 'payment_frequency_interval'
	| 'metadata'
	| 'scheduled_change'
> & { customer: Pick<Subscription['customer'], 'customer_id'> };

function stubSubscriptionFetch(subscription: ProviderSubscription) {
	const fetchMock = vi.fn(async (input: Request | string | URL) => {
		const path = new URL(input instanceof Request ? input.url : String(input)).pathname;

		if (path === '/subscriptions/sub_reconciliation') return Response.json(subscription);

		throw new Error(`Unexpected Dodo request: ${path}`);
	});

	vi.stubGlobal('fetch', fetchMock);

	return fetchMock;
}

function dodoSubscription(overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
	return {
		subscription_id: 'sub_reconciliation',
		product_id: 'prod_pro',
		status: 'active',
		previous_billing_date: new Date(termEnd).toISOString(),
		next_billing_date: new Date(termEnd + 30 * 86_400_000).toISOString(),
		cancel_at_next_billing_date: false,
		payment_frequency_count: 1,
		payment_frequency_interval: 'Month',
		customer: { customer_id: 'cus_reconciliation' },
		metadata: { userId, tierId: 'pro' },
		scheduled_change: null,
		...overrides
	};
}

const reconcileArgs = (
	subscriptionId: import('@convex/_generated/dataModel').Id<'subscriptions'>
) => ({
	subscriptionId,
	dodoSubscriptionId: 'sub_reconciliation',
	projectionRevision: 1,
	force: true as const
});

async function seedAndAct(
	t: ConvexTestInstance,
	observation: Partial<ProviderSubscription> = {},
	actionArgs: Partial<
		FunctionArgs<typeof internal.subscriptionReconciliation.reconcileSubscription>
	> = {}
): Promise<{
	subscriptionId: import('@convex/_generated/dataModel').Id<'subscriptions'>;
	fetchMock: ReturnType<typeof stubSubscriptionFetch>;
	result: FunctionReturnType<typeof internal.subscriptionReconciliation.reconcileSubscription>;
}> {
	await seed(t);
	const subscription = (await readSubscription(t))!;
	const fetchMock = stubSubscriptionFetch(dodoSubscription(observation));

	const result = await t.action(internal.subscriptionReconciliation.reconcileSubscription, {
		...reconcileArgs(subscription._id),
		...actionArgs
	});

	return { subscriptionId: subscription._id, fetchMock, result };
}

describe('subscription reconciliation retrieval', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('fetches, parses, and applies the observation through the fenced projection', async () => {
		const t = initConvexTest();
		const { fetchMock, result } = await seedAndAct(t);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ outcome: 'observed' });
		expect(await readSubscription(t)).toMatchObject({
			status: 'active',
			accessPhase: 'paid',
			billingPeriodStart: termEnd,
			billingPeriodEnd: termEnd + 30 * 86_400_000
		});
	});

	it('defers with a bounded retry on a provider fetch failure', async () => {
		const t = initConvexTest();
		await seed(t);
		const subscription = (await readSubscription(t))!;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ message: 'boom' }, { status: 500 }))
		);

		const result = await t.action(
			internal.subscriptionReconciliation.reconcileSubscription,
			reconcileArgs(subscription._id)
		);

		expect(result.outcome).toBe('deferred');

		expect(
			await t.query(internal.subscriptionReconciliation.getReconciliation, {
				subscriptionId: subscription._id
			})
		).toMatchObject({ state: 'pending', attempt: 1 });

		// The row itself is untouched.
		expect(await readSubscription(t)).toMatchObject({
			accessPhase: 'renewal_processing',
			billingPeriodStart: termStart
		});
	});

	it('returns failed on an unsupported observed status without touching the row', async () => {
		const t = initConvexTest();
		const { result } = await seedAndAct(t, { status: 'paused' });

		expect(result.outcome).toBe('failed');
		expect(await readSubscription(t)).toMatchObject({
			status: 'active',
			accessPhase: 'renewal_processing',
			billingPeriodStart: termStart
		});
	});

	it('skips the observation when the projection revision advanced during the fetch', async () => {
		const t = initConvexTest();
		await seed(t);

		const subscription = (await readSubscription(t))!;

		vi.stubGlobal('fetch', async () => {
			await t.run((ctx) =>
				ctx.db.patch('subscriptions', subscription._id, { projectionRevision: 2 })
			);

			return Response.json(dodoSubscription());
		});

		const result = await t.action(
			internal.subscriptionReconciliation.reconcileSubscription,
			reconcileArgs(subscription._id)
		);

		expect(result.outcome).toBe('skipped');
		expect(await readSubscription(t)).toMatchObject({
			accessPhase: 'renewal_processing',
			billingPeriodStart: termStart
		});
	});
});
