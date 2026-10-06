import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, type ConvexTestInstance } from './test.setup';

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

function stubDodo(routes: {
	onCreateSession?: (request: Request) => Response | Promise<Response>;
	onSessionStatus?: (sessionId: string) => Response;
}): Request[] {
	const requests: Request[] = [];

	vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		requests.push(request.clone());
		const path = new URL(request.url).pathname;

		if (path === '/customers') return Response.json({ customer_id: 'cus_test' });

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
			return (
				(await routes.onCreateSession?.(request)) ??
				Response.json({
					session_id: 'cks_1',
					checkout_url: 'https://checkout.example/cks_1'
				})
			);
		}

		if (path.startsWith('/checkouts/')) {
			const sessionId = path.split('/').at(-1) ?? '';

			return (
				routes.onSessionStatus?.(sessionId) ??
				Response.json({
					id: sessionId,
					created_at: new Date().toISOString(),
					payment_id: null,
					payment_status: null
				})
			);
		}

		throw new Error(`Unexpected Dodo request: ${path}`);
	});

	return requests;
}

async function seedProTier(t: ConvexTestInstance) {
	vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
	vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
	vi.stubEnv('DODO_PAYMENTS_WEBHOOK_SECRET', 'whsec_test');
	vi.stubEnv('DODO_CHECKOUT_IDEMPOTENCY_WINDOW_MS', '3600000');
	vi.stubEnv('SPROCKET_MARKETING_ORIGIN', 'https://spikonado.com');

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
}

describe('checkout local purchase delegation', () => {
	it('delegates a new checkout to the provider for an active Free bootstrap row', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const requests = stubDodo({});
		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		await owner.mutation(api.billing.ensureMySubscription, {});

		const bootstrap = await t.run(async (ctx) =>
			ctx.db
				.query('subscriptions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		expect(bootstrap).toMatchObject({ tier: 'free', status: 'active' });

		const result = await owner.action(api.billing.checkout, {
			tier: 'pro',
			interval: 'monthly'
		});

		expect(result.mode).toBe('test');
		expect(result.checkout_url).toBe('https://checkout.example/cks_1');
		expect(
			requests.filter((request) => new URL(request.url).pathname === '/checkouts')
		).toHaveLength(1);
	});

	it('delegates a new checkout to the provider while a paid subscription is active', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const now = Date.now();

		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId: 'owner',
				tier: 'pro',
				status: 'active',
				eventAt: now - 1_000,
				dodoSubscriptionId: 'sub_1',
				billingPeriodStart: now - 86_400_000,
				billingPeriodEnd: now + 86_400_000,
				accessPhase: 'paid',
				accessEndsAt: now + 86_400_000
			});
		});

		const requests = stubDodo({});
		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		const result = await owner.action(api.billing.checkout, {
			tier: 'pro',
			interval: 'monthly'
		});

		expect(result.mode).toBe('test');
		expect(result.checkout_url).toBe('https://checkout.example/cks_1');
		expect(
			requests.filter((request) => new URL(request.url).pathname === '/checkouts')
		).toHaveLength(1);
	});

	it('delegates a new checkout to the provider for an ended recoverable paid row', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const now = Date.now();

		await t.run(async (ctx) => {
			await ctx.db.insert('subscriptions', {
				userId: 'owner',
				tier: 'pro',
				status: 'active',
				eventAt: now - 2 * 86_400_000,
				dodoSubscriptionId: 'sub_1',
				billingPeriodStart: now - 2 * 86_400_000,
				billingPeriodEnd: now - 86_400_000,
				billingPeriodEnded: true,
				accessPhase: 'none',
				accessEndsAt: now - 86_400_000
			});
		});

		const requests = stubDodo({});
		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		const result = await owner.action(api.billing.checkout, {
			tier: 'pro',
			interval: 'monthly'
		});

		expect(result.mode).toBe('test');
		expect(result.checkout_url).toBe('https://checkout.example/cks_1');
		expect(
			requests.filter((request) => new URL(request.url).pathname === '/checkouts')
		).toHaveLength(1);
	});
});

describe('checkout attempt recovery', () => {
	it('reissues the same idempotency key after an ambiguous create and attaches one session', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });
		let createCalls = 0;

		const requests = stubDodo({
			onCreateSession: () => {
				createCalls += 1;

				if (createCalls === 1) {
					return new Response(null, { status: 500, statusText: 'boom' });
				}

				return Response.json({
					session_id: 'cks_recovered',
					checkout_url: 'https://checkout.example/cks_recovered'
				});
			}
		});

		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).rejects.toThrow('could not be confirmed');

		// Ambiguous retry pacing: an immediate retry is told to wait.
		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).rejects.toThrow('still confirming');

		vi.setSystemTime(Date.now() + 31_000);

		await expect(
			owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' })
		).resolves.toEqual({
			checkout_url: 'https://checkout.example/cks_recovered',
			mode: 'test',
			attemptId: expect.any(String),
			sessionId: 'cks_recovered'
		});

		const checkoutCreates = requests.filter(
			(request) => new URL(request.url).pathname === '/checkouts'
		);

		expect(checkoutCreates).toHaveLength(2);

		const keys = checkoutCreates.map((request) => request.headers.get('Idempotency-Key'));

		expect(keys[0]).toBe(keys[1]);
		expect(keys[0]).toMatch(/^sprocket-checkout:/);

		const attempt = await t.run(async (ctx) =>
			ctx.db
				.query('billingCheckoutSessions')
				.withIndex('by_userId', (query) => query.eq('userId', 'owner'))
				.unique()
		);

		expect(attempt).toMatchObject({
			outcome: 'created',
			dodoSessionId: 'cks_recovered',
			checkoutUrl: 'https://checkout.example/cks_recovered'
		});
	});

	it('does not create a second provider session for the same selection', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });
		let createCalls = 0;

		stubDodo({
			onCreateSession: () => {
				createCalls += 1;

				return Response.json({
					session_id: 'cks_same',
					checkout_url: 'https://checkout.example/cks_same'
				});
			}
		});

		const first = await owner.action(api.billing.checkout, {
			tier: 'pro',
			interval: 'monthly'
		});

		expect(first.sessionId).toBe('cks_same');
		expect(createCalls).toBe(1);

		const again = await owner.action(api.billing.checkout, {
			tier: 'pro',
			interval: 'monthly'
		});

		expect(again).toMatchObject({
			checkout_url: 'https://checkout.example/cks_same',
			mode: 'test',
			attemptId: first.attemptId,
			sessionId: 'cks_same'
		});
		expect(createCalls).toBe(1);
	});

	it('recovers an unpaid checkout as awaiting_payment without creating a new provider session', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });
		let createCalls = 0;

		const requests = stubDodo({
			onCreateSession: () => {
				createCalls += 1;

				return Response.json({
					session_id: 'cks_unpaid',
					checkout_url: 'https://checkout.example/cks_unpaid'
				});
			},
			onSessionStatus: (sessionId) =>
				Response.json({
					id: sessionId,
					created_at: new Date().toISOString(),
					payment_id: null,
					payment_status: 'awaiting_payment'
				})
		});

		const checkout = await owner.action(api.billing.checkout, {
			tier: 'pro',
			interval: 'monthly'
		});

		if (!checkout.attemptId) throw new Error('Missing checkout attempt.');
		expect(checkout.checkout_url).toBe('https://checkout.example/cks_unpaid');
		expect(createCalls).toBe(1);

		// Past the local TTL the stored checkout URL is still the resume point.
		vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1_000);

		const status = await owner.action(api.billing.getCheckoutStatus, {
			attemptId: checkout.attemptId
		});

		expect(status).toMatchObject({
			status: 'awaiting_payment',
			mode: 'test',
			checkout_url: 'https://checkout.example/cks_unpaid',
			sessionId: 'cks_unpaid'
		});

		expect(
			requests.filter((request) => new URL(request.url).pathname === '/checkouts')
		).toHaveLength(1);
		expect(createCalls).toBe(1);
	});

	it('keeps a retained test-mode checkout at mode test and unknown after the config flips to live', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		const requests = stubDodo({});

		const checkout = await owner.action(api.billing.checkout, {
			tier: 'pro',
			interval: 'monthly'
		});

		if (!checkout.attemptId) throw new Error('Missing checkout attempt.');
		expect(checkout.mode).toBe('test');

		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'live_mode');
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'live_key');

		// The attempt belongs to the test environment: no provider fetch may go
		// out under live credentials, and the stored mode stays test.
		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: checkout.attemptId })
		).resolves.toMatchObject({
			mode: 'test',
			status: 'unknown',
			checkout_url: 'https://checkout.example/cks_1',
			sessionId: 'cks_1'
		});

		expect(
			requests.filter((request) => new URL(request.url).pathname.startsWith('/checkouts'))
		).toHaveLength(1);
	});
});

describe('getCheckoutStatus', () => {
	it.each([
		['paid', 'succeeded', 'live_mode', 'live', ''],
		['paid', 'succeeded', 'test_mode', 'test', 'invalid'],
		['failed', 'failed', 'live_mode', 'live', 'invalid'],
		['failed', 'failed', 'test_mode', 'test', '']
	] as const)(
		'reports stored %s status %s in %s/%s with current environment %j',
		async (outcome, status, dodoEnvironment, mode, currentEnvironment) => {
			const t = initConvexTest();
			await seedProTier(t);
			const requests = stubDodo({});
			await t.run(async (ctx) => {
				await ctx.db.insert('billingCheckoutAttempts', {
					userId: 'owner',
					attemptId: 'attempt_settled',
					tierId: 'pro',
					interval: 'monthly',
					productId: 'prod_monthly',
					dodoEnvironment,
					outcome,
					expiresAt: Date.now() - 1_000
				});
			});
			vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', currentEnvironment);
			vi.stubEnv('DODO_PAYMENTS_API_KEY', '');
			const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

			await expect(
				owner.action(api.billing.getCheckoutStatus, { attemptId: 'attempt_settled' })
			).resolves.toMatchObject({ status, mode });
			expect(requests).toEqual([]);
		}
	);

	it('is bound to the owning account', async () => {
		const t = initConvexTest();
		await seedProTier(t);

		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutSessions', {
				userId: 'owner',
				attemptId: 'attempt_owned',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				checkoutUrl: 'https://checkout.example/cks_owned',
				dodoSessionId: 'cks_owned',
				outcome: 'created',
				expiresAt: Date.now() + 60_000
			});
		});

		const other = t.withIdentity({ subject: 'other', email: 'other@example.com' });

		await expect(
			other.action(api.billing.getCheckoutStatus, { attemptId: 'attempt_owned' })
		).rejects.toThrow('Unknown checkout attempt.');
	});

	it('reports neutral provider-backed status for an awaiting session', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		stubDodo({});

		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutSessions', {
				userId: 'owner',
				attemptId: 'attempt_open',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				checkoutUrl: 'https://checkout.example/cks_open',
				dodoSessionId: 'cks_open',
				outcome: 'created',
				expiresAt: Date.now() + 60_000
			});
		});

		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: 'attempt_open' })
		).resolves.toMatchObject({
			status: 'awaiting_payment',
			mode: 'test',
			checkout_url: 'https://checkout.example/cks_open',
			sessionId: 'cks_open'
		});
	});

	it('reports succeeded without a checkout URL once the provider payment succeeds', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		stubDodo({
			onSessionStatus: (sessionId) =>
				Response.json({
					id: sessionId,
					created_at: new Date().toISOString(),
					payment_id: 'pay_1',
					payment_status: 'succeeded'
				})
		});

		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutSessions', {
				userId: 'owner',
				attemptId: 'attempt_paid',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				checkoutUrl: 'https://checkout.example/cks_paid',
				dodoSessionId: 'cks_paid',
				outcome: 'created',
				expiresAt: Date.now() + 60_000
			});
		});

		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		const status = await owner.action(api.billing.getCheckoutStatus, {
			attemptId: 'attempt_paid'
		});

		expect(status.status).toBe('succeeded');
		expect(status.mode).toBe('test');
		expect(status.checkout_url).toBeUndefined();
	});

	it('queries the provider for an attached session past the local expiry', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const requests = stubDodo({});

		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutSessions', {
				userId: 'owner',
				attemptId: 'attempt_old',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				dodoSessionId: 'cks_old',
				outcome: 'created',
				expiresAt: Date.now() - 1_000
			});
		});

		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: 'attempt_old' })
		).resolves.toMatchObject({ status: 'awaiting_payment', mode: 'test', sessionId: 'cks_old' });

		// Local expiry is not provider expiry: the attached session is queried.
		expect(
			requests.filter((request) => new URL(request.url).pathname.startsWith('/checkouts/'))
		).toHaveLength(1);
	});

	it('finds retained superseded attempts', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		stubDodo({});
		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		const first = await owner.action(api.billing.checkout, {
			tier: 'pro',
			interval: 'monthly'
		});

		if (!first.attemptId) throw new Error('Expected an attempt id.');

		await owner.action(api.billing.checkout, { tier: 'pro', interval: 'annual' });

		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: first.attemptId })
		).resolves.toMatchObject({
			attemptId: first.attemptId,
			status: 'awaiting_payment',
			mode: 'test'
		});
	});

	it('reports a locally expired uncreated reservation as expired', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const requests = stubDodo({});

		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutSessions', {
				userId: 'owner',
				attemptId: 'attempt_reserved',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				outcome: 'reserved',
				idempotencyKey: 'sprocket-checkout:key_reserved',
				expiresAt: Date.now() - 1_000
			});
		});

		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: 'attempt_reserved' })
		).resolves.toMatchObject({ status: 'expired', mode: 'test' });

		expect(
			requests.filter((request) => new URL(request.url).pathname.startsWith('/checkouts'))
		).toEqual([]);
	});

	it('never reports a locally expired ambiguous create as expired', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		stubDodo({
			onSessionStatus: (sessionId) =>
				Response.json({
					id: sessionId,
					created_at: new Date().toISOString(),
					payment_id: null,
					payment_status: null
				})
		});

		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutAttempts', {
				userId: 'owner',
				attemptId: 'attempt_ambiguous_old',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				outcome: 'create_ambiguous',
				idempotencyKey: 'sprocket-checkout:key_ambiguous',
				createRequest: {
					productId: 'prod_monthly',
					returnUrl: 'https://spikonado.com/pricing?checkout=return&tier=pro',
					cancelUrl: 'https://spikonado.com/pricing?checkout=cancel&tier=pro',
					dodoCustomerId: 'cus_test'
				},
				expiresAt: Date.now() - 1_000
			});
		});

		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		const status = await owner.action(api.billing.getCheckoutStatus, {
			attemptId: 'attempt_ambiguous_old'
		});

		expect(status.status).not.toBe('expired');
		expect(['pending', 'awaiting_payment', 'unknown']).toContain(status.status);
	});

	it('keeps an attached session recoverable when provider retrieval fails', async () => {
		const t = initConvexTest();
		await seedProTier(t);
		const requests = stubDodo({ onSessionStatus: () => new Response(null, { status: 404 }) });
		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });
		const checkout = await owner.action(api.billing.checkout, { tier: 'pro', interval: 'monthly' });

		if (!checkout.attemptId) throw new Error('Missing checkout attempt.');
		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: checkout.attemptId })
		).resolves.toMatchObject({
			status: 'unknown',
			mode: 'test',
			sessionId: 'cks_1',
			checkout_url: checkout.checkout_url
		});
		expect(
			requests.filter((request) => new URL(request.url).pathname === '/checkouts')
		).toHaveLength(1);
	});

	it('keeps an ambiguous create unknown when the provider lookup fails', async () => {
		const t = initConvexTest();
		await seedProTier(t);

		// Neither the replay nor the fallback session readback resolves.
		stubDodo({
			onCreateSession: () => new Response(null, { status: 500 }),
			onSessionStatus: () => new Response(null, { status: 500 })
		});

		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutAttempts', {
				userId: 'owner',
				attemptId: 'attempt_unresolved',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				outcome: 'create_ambiguous',
				idempotencyKey: 'sprocket-checkout:key_unresolved',
				createRequest: {
					productId: 'prod_monthly',
					returnUrl: 'https://spikonado.com/pricing?checkout=return&tier=pro',
					cancelUrl: 'https://spikonado.com/pricing?checkout=cancel&tier=pro',
					dodoCustomerId: 'cus_test'
				},
				expiresAt: Date.now() - 1_000
			});
		});

		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: 'attempt_unresolved' })
		).resolves.toMatchObject({ status: 'unknown', mode: 'test' });
	});

	it('fails closed on a legacy ambiguous row without a frozen request', async () => {
		const t = initConvexTest();
		await seedProTier(t);

		await t.run(async (ctx) => {
			await ctx.db.insert('billingCheckoutAttempts', {
				userId: 'owner',
				attemptId: 'attempt_legacy',
				tierId: 'pro',
				interval: 'monthly',
				productId: 'prod_monthly',
				outcome: 'create_ambiguous',
				expiresAt: Date.now() - 1_000
			});
		});

		const owner = t.withIdentity({ subject: 'owner', email: 'owner@example.com' });

		await expect(
			owner.action(api.billing.getCheckoutStatus, { attemptId: 'attempt_legacy' })
		).resolves.toMatchObject({ status: 'unknown', mode: 'test' });
	});
});
