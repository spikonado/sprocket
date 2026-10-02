import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';
import {
	drainWebhookJobs,
	sendSubscriptionWebhook,
	subscriptionPayload
} from './billingWebhook.test.setup';

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function billingFixture() {
	vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
	vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
	vi.stubEnv('DODO_PAYMENTS_WEBHOOK_SECRET', 'configured');
	vi.stubEnv('DODO_CHECKOUT_IDEMPOTENCY_WINDOW_MS', '3600000');
	vi.stubEnv('SPROCKET_MARKETING_ORIGIN', 'https://spikonado.com');
	const t = initConvexTest();
	await t.run(async (ctx) => {
		await ctx.db.insert('tiers', {
			tierId: 'pro',
			label: 'Pro',
			weekly: 1,
			monthly: 1,
			monthlyProductId: 'prod_monthly',
			annualProductId: 'prod_annual'
		});
		await ctx.db.insert('tiers', { tierId: 'free', label: 'Free', weekly: 1, monthly: 1 });
	});
	const requests: Request[] = [];
	vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		requests.push(request.clone());
		const path = new URL(request.url).pathname;

		if (path === '/customers') return Response.json({ customer_id: 'cus_owner' });

		if (path.startsWith('/products/')) {
			return Response.json({
				product_id: path.split('/').at(-1),
				name: 'Pro',
				price: {
					type: 'recurring_price',
					price: 2_000,
					currency: 'USD',
					payment_frequency_count: 1,
					payment_frequency_interval: path.endsWith('prod_annual') ? 'Year' : 'Month'
				}
			});
		}

		if (path === '/checkouts') {
			const body = await request.json();

			return Response.json({
				session_id: `cks_${body.product_cart[0].product_id}`,
				checkout_url: `https://checkout.example/${body.product_cart[0].product_id}`
			});
		}

		throw new Error(`Unexpected Dodo request: ${path}`);
	});

	return { t, requests, owner: t.withIdentity({ subject: 'owner', email: 'owner@example.com' }) };
}

type CheckoutCreateBody = { product_cart: [{ product_id: string }] };

function stubDodoCheckoutCreates(
	onCreateSession?: (body: CheckoutCreateBody) => Response | Promise<Response>
) {
	const requests: Request[] = [];

	vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const path = new URL(request.url).pathname;

		if (path === '/customers') return Response.json({ customer_id: 'cus_owner' });

		if (path.startsWith('/products/')) {
			return Response.json({
				product_id: path.split('/').at(-1),
				name: 'Pro',
				price: {
					type: 'recurring_price',
					price: 2_000,
					currency: 'USD',
					payment_frequency_count: 1,
					payment_frequency_interval: path.endsWith('prod_annual') ? 'Year' : 'Month'
				}
			});
		}

		if (path === '/checkouts') {
			requests.push(request.clone());
			const body = await request.json();

			return (
				onCreateSession?.(body) ??
				Response.json({
					session_id: `cks_${body.product_cart[0].product_id}`,
					checkout_url: `https://checkout.example/${body.product_cart[0].product_id}`
				})
			);
		}

		throw new Error(`Unexpected Dodo request: ${path}`);
	});

	return requests;
}

describe('checkout selection changes', () => {
	it('allows a healthy selection after product validation fails before creation', async () => {
		const { t, owner, requests } = await billingFixture();
		const providerFetch = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
			const request = input instanceof Request ? input : new Request(input, init);

			if (new URL(request.url).pathname === '/products/prod_monthly') {
				return new Response(null, { status: 404 });
			}

			return providerFetch(request);
		});

		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).rejects.toThrow();
		expect(await t.run((ctx) => ctx.db.query('billingCheckoutSessions').unique())).toMatchObject({
			outcome: 'reserved'
		});
		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' })
		).resolves.toMatchObject({ checkout_url: 'https://checkout.example/prod_annual' });
		expect(
			requests.filter((request) => new URL(request.url).pathname === '/checkouts')
		).toHaveLength(1);
	});

	it('enforces the retained-history cap before delegating another purchase', async () => {
		const { t, owner } = await billingFixture();
		await t.run(async (ctx) => {
			for (let index = 0; index < 25; index++) {
				await ctx.db.insert('billingCheckoutAttempts', {
					userId: 'owner',
					attemptId: `paid_${index}`,
					tierId: 'pro',
					interval: 'monthly',
					productId: 'prod_monthly',
					outcome: 'paid',
					expiresAt: Date.now()
				});
			}
		});
		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' })
		).rejects.toThrow(/reconcile existing checkouts/);
	});

	it('opens a different interval immediately on the same saved customer and reuses matching retries', async () => {
		const { t, owner, requests } = await billingFixture();
		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).resolves.toMatchObject({ checkout_url: 'https://checkout.example/prod_monthly' });
		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' })
		).resolves.toMatchObject({ checkout_url: 'https://checkout.example/prod_annual' });
		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' });

		const customerRequests = requests.filter(
			(request) => new URL(request.url).pathname === '/customers'
		);

		expect(customerRequests).toHaveLength(1);
		expect(customerRequests[0]!.headers.get('Idempotency-Key')).toBe('sprocket-customer:owner');
		const checkouts = requests.filter((request) => new URL(request.url).pathname === '/checkouts');
		expect(checkouts).toHaveLength(2);

		for (const request of checkouts) {
			expect(await request.json()).toMatchObject({
				customer: { customer_id: 'cus_owner' },
				feature_flags: { always_create_new_customer: false, allow_customer_editing_email: false }
			});
		}

		expect(checkouts[0]!.headers.get('Idempotency-Key')).not.toBe(
			checkouts[1]!.headers.get('Idempotency-Key')
		);
		await expect(
			t.query(internal.billingCustomers.get, { userId: 'owner' })
		).resolves.toMatchObject({ dodoCustomerId: 'cus_owner' });
	});

	it('retains the saved customer across concurrent creation results', async () => {
		const { t, requests } = await billingFixture();
		await Promise.all([
			t.action(internal.pricing.ensureCustomer, {
				userId: 'owner',
				email: 'owner@example.com',
				name: 'Owner'
			}),
			t.action(internal.pricing.ensureCustomer, {
				userId: 'owner',
				email: 'owner@example.com',
				name: 'Owner'
			})
		]);
		await expect(
			t.mutation(internal.billingCustomers.remember, {
				userId: 'owner',
				dodoCustomerId: 'cus_late'
			})
		).resolves.toBe('cus_owner');
		const keys = requests.map((request) => request.headers.get('Idempotency-Key'));
		expect(keys.every((key) => key === 'sprocket-customer:owner')).toBe(true);
		await expect(
			t.action(internal.pricing.ensureCustomer, { userId: 'owner', name: 'Owner' })
		).resolves.toBe('cus_owner');
	});

	it('honors an older checkout that is paid after the customer selects a different interval', async () => {
		const { t, owner } = await billingFixture();
		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });

		const monthly = await t.run(async (ctx) => ctx.db.query('billingCheckoutSessions').unique());

		if (!monthly) throw new Error('Missing monthly checkout reservation.');

		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' });

		const now = Date.now();

		const response = await sendSubscriptionWebhook(
			t,
			'subscription.active',
			subscriptionPayload({
				subscription_id: 'sub_monthly',
				product_id: 'prod_monthly',
				metadata: { userId: 'owner', tierId: 'pro', checkoutAttemptId: monthly.attemptId },
				previous_billing_date: new Date(now),
				next_billing_date: new Date(now + 30 * 86_400_000)
			}),
			now
		);

		expect(response.status).toBe(200);
		await drainWebhookJobs(t);

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		expect(stored).toMatchObject({
			tier: 'pro',
			status: 'active',
			eventAt: now,
			billingInterval: 'monthly',
			dodoSubscriptionId: 'sub_monthly',
			dodoProductId: 'prod_monthly'
		});
		await expect(owner.query(api.billing.getMySubscription, {})).resolves.toMatchObject({
			tier: 'pro',
			billingManaged: true
		});

		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' })
		).resolves.toMatchObject({
			checkout_url: 'https://checkout.example/prod_annual',
			mode: 'test'
		});
	});

	it('retains a late monthly attachment without replacing the current annual reservation', async () => {
		const { t, owner } = await billingFixture();
		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });

		const monthly = await t.run(async (ctx) => ctx.db.query('billingCheckoutSessions').unique());

		if (!monthly) throw new Error('Missing monthly checkout reservation.');

		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' });

		const annual = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		if (!annual) throw new Error('Missing annual checkout reservation.');

		await expect(
			t.mutation(internal.billing.attachCheckoutSession, {
				userId: 'owner',
				attemptId: monthly.attemptId,
				checkoutUrl: 'https://checkout.example/prod_monthly'
			})
		).resolves.toBe(false);

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		expect(stored).toMatchObject({
			attemptId: annual.attemptId,
			tierId: 'pro',
			interval: 'annual',
			productId: 'prod_annual',
			expiresAt: annual.expiresAt,
			checkoutUrl: 'https://checkout.example/prod_annual'
		});
	});

	it('freezes one create request and idempotency key across concurrent ambiguous retries', async () => {
		const { t, owner } = await billingFixture();

		// Fail the first provider create so the attempt turns ambiguous, then
		// hold the replay requests so two retries overlap at the freeze.
		let createCalls = 0;
		let release: (() => void) | undefined;

		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const requests = stubDodoCheckoutCreates(async () => {
			createCalls += 1;

			if (createCalls === 1) return new Response(null, { status: 500 });

			await gate;

			return Response.json({
				session_id: 'cks_frozen',
				checkout_url: 'https://checkout.example/cks_frozen'
			});
		});

		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).rejects.toThrow('could not be confirmed');

		vi.setSystemTime(Date.now() + 31_000);

		const first = owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });
		const second = owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });

		await vi.waitFor(() => {
			if (createCalls < 2) throw new Error('Waiting for the first replay.');
		});
		release?.();

		const results = await Promise.allSettled([first, second]);

		const fulfilled = results.filter((result) => result.status === 'fulfilled');

		// Both concurrent retries may succeed on the same replayed session;
		// the guarantee under test is one frozen key/body, not a single winner.
		expect(fulfilled.length).toBeGreaterThanOrEqual(1);
		expect(fulfilled[0]!.value.checkout_url).toBe('https://checkout.example/cks_frozen');

		const replays = requests.filter((request) => new URL(request.url).pathname === '/checkouts');

		// The original failed create plus one replay: concurrent retries share
		// the first frozen key instead of each sending their own body.
		expect(replays.length).toBeGreaterThanOrEqual(2);
		const replayBodies = await Promise.all(replays.map((request) => request.json()));
		const replayKeys = replays.map((request) => request.headers.get('Idempotency-Key'));
		expect(new Set(replayKeys).size).toBe(1);

		for (const body of replayBodies) {
			expect(body).toMatchObject({
				product_cart: [{ product_id: 'prod_monthly', quantity: 1 }]
			});
		}

		const attempt = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		expect(attempt?.createRequest).toMatchObject({ productId: 'prod_monthly' });
		expect(attempt?.idempotencyKey).toBe(replayKeys[0]);
	});

	it('retries a retained ambiguous attempt after a selection switch with its original key', async () => {
		const { t, owner } = await billingFixture();

		let failNextMonthly = true;

		const requests = stubDodoCheckoutCreates((body) => {
			if (body.product_cart[0].product_id === 'prod_monthly' && failNextMonthly) {
				failNextMonthly = false;

				return new Response(null, { status: 500 });
			}

			return Response.json({
				session_id: `cks_${body.product_cart[0].product_id}`,
				checkout_url: `https://checkout.example/${body.product_cart[0].product_id}`
			});
		});

		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).rejects.toThrow('could not be confirmed');

		const ambiguous = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		if (!ambiguous?.idempotencyKey) throw new Error('Missing ambiguous attempt key.');

		// Retain the ambiguous attempt (the state a selection switch produces)
		// by moving it to the attempts table, then resume it with its original
		// key from the retained table.
		await t.run(async (ctx) => {
			const session = await ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId_and_attemptId', (query) =>
					query.eq('userId', 'owner').eq('attemptId', ambiguous.attemptId)
				)
				.unique();

			if (!session) throw new Error('Missing ambiguous session row.');

			await ctx.db.insert('billingCheckoutAttempts', {
				userId: session.userId,
				attemptId: session.attemptId,
				tierId: session.tierId,
				interval: session.interval,
				productId: session.productId,
				checkoutUrl: session.checkoutUrl,
				dodoSessionId: session.dodoSessionId,
				idempotencyKey: session.idempotencyKey,
				outcome: session.outcome,
				outcomeUpdatedAt: session.outcomeUpdatedAt,
				createRequest: session.createRequest,
				createStartedAt: session.createStartedAt,
				dodoEnvironment: session.dodoEnvironment,
				expiresAt: session.expiresAt
			});
			await ctx.db.delete('billingCheckoutSessions', session._id);
		});

		vi.setSystemTime(Date.now() + 31_000);

		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).resolves.toMatchObject({ checkout_url: 'https://checkout.example/prod_monthly' });

		const monthlyCreates = requests.filter(
			(request) =>
				new URL(request.url).pathname === '/checkouts' &&
				request.headers.get('Idempotency-Key') === ambiguous.idempotencyKey
		);

		expect(monthlyCreates.length).toBeGreaterThanOrEqual(2);
	});

	it('allows a different selection while an old-environment attempt is merely archived', async () => {
		const { t, owner } = await billingFixture();
		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });

		const monthly = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		if (!monthly) throw new Error('Missing monthly checkout reservation.');

		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'live_mode');

		await expect(
			t.mutation(internal.billing.reserveCheckoutSession, {
				userId: 'owner',
				tierId: 'pro',
				interval: 'annual',
				productId: 'prod_annual',
				now: Date.now()
			})
		).resolves.toMatchObject({
			kind: 'create',
			productId: 'prod_annual'
		});

		const retained = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutAttempts')
				.withIndex('by_userId_and_attemptId', (query) =>
					query.eq('userId', 'owner').eq('attemptId', monthly.attemptId)
				)
				.unique()
		);

		expect(retained).toMatchObject({ attemptId: monthly.attemptId, dodoEnvironment: 'test_mode' });
	});

	it('resuming a same-selection hosted link keeps its original environment after a config flip', async () => {
		const { t, owner } = await billingFixture();

		const first = await owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });

		expect(first.mode).toBe('test');

		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'live_mode');

		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).rejects.toThrow('different payment environment');

		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: first.attemptId! })
		).resolves.toMatchObject({
			mode: 'test',
			status: 'unknown',
			checkout_url: 'https://checkout.example/prod_monthly'
		});
	});
});
