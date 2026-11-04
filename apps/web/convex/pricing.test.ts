import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import {
	DODO_FETCH_BUDGET_PER_OPERATION,
	DODO_FETCH_CONCURRENCY,
	DODO_PRICE_TRANSIENT_RETRY_MS
} from './pricing';
import { initConvexTest } from './test.setup';

const ENV_KEYS = ['DODO_PAYMENTS_API_KEY', 'DODO_PAYMENTS_ENVIRONMENT'] as const;

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('public pricing catalog', () => {
	it.each(['request', 'interval', 'assignment'])(
		'keeps healthy prices when another product has a %s failure',
		async (failure) => {
			vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
			vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
			vi.spyOn(console, 'error').mockImplementation(() => {});
			let recovered = false;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (request: Request | string | URL) => {
					const url = new URL(request instanceof Request ? request.url : String(request));
					const productId = url.pathname.split('/').at(-1);

					if (productId === 'prod_broken' && failure === 'request' && !recovered) {
						return Response.json({ message: 'Invalid product' }, { status: 400 });
					}

					return Response.json({
						product_id: productId,
						name: productId,
						price: {
							type: 'recurring_price',
							price: 2_000,
							currency: 'USD',
							payment_frequency_count: 1,
							payment_frequency_interval:
								productId === 'prod_broken' && !recovered ? 'Year' : 'Month'
						}
					});
				})
			);
			const t = initConvexTest();
			await t.run(async (ctx) => {
				await ctx.db.insert('tiers', {
					tierId: 'team',
					label: 'Team',
					monthly: 1,
					monthlyProductId: 'prod_healthy',
					annualProductId: failure === 'assignment' ? 'prod_broken' : undefined
				});
				await ctx.db.insert('tiers', {
					tierId: 'pro',
					label: 'Pro',
					monthly: 1,
					monthlyProductId: 'prod_broken'
				});
			});

			const catalog = await t.action(api.pricing.getPublicCatalog, {});
			expect(catalog.plans.find((plan) => plan.id === 'team')?.prices).toMatchObject({
				monthly: { productId: 'prod_healthy', amountMinor: 2_000 },
				annual: null
			});
			expect(catalog.plans.find((plan) => plan.id === 'pro')?.prices.monthly).toBeNull();

			if (failure === 'request') {
				recovered = true;
				vi.setSystemTime(Date.now() + DODO_PRICE_TRANSIENT_RETRY_MS + 1_000);
				const recoveredCatalog = await t.action(api.pricing.getPublicCatalog, {});

				expect(
					recoveredCatalog.plans.find((plan) => plan.id === 'pro')?.prices.monthly
				).toMatchObject({ productId: 'prod_broken', amountMinor: 2_000 });
			}
		}
	);

	it('returns every tier in card order with card defaults when Dodo is not configured', async () => {
		for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				monthly: 100 * MODEL_USAGE_UNITS_PER_DOLLAR,
				description: 'For teams shipping hardware.',
				features: ['Shared projects'],
				displayOrder: 20,
				highlighted: true,
				monthlyProductId: 'prod_team_monthly'
			});
			await ctx.db.insert('tiers', {
				tierId: 'free',
				label: 'Free',
				monthly: 15 * MODEL_USAGE_UNITS_PER_DOLLAR
			});
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				monthly: 75 * MODEL_USAGE_UNITS_PER_DOLLAR
			});
		});

		await expect(t.action(api.pricing.getPublicCatalog, {})).resolves.toEqual({
			plans: [
				{
					id: 'free',
					label: 'Free',
					monthlyUsageDollars: 15,
					description: null,
					features: [],
					displayOrder: 0,
					highlighted: false,
					prices: { monthly: null, annual: null }
				},
				{
					id: 'team',
					label: 'Team',
					monthlyUsageDollars: 100,
					description: 'For teams shipping hardware.',
					features: ['Shared projects'],
					displayOrder: 20,
					highlighted: true,
					prices: { monthly: null, annual: null }
				},
				{
					id: 'pro',
					label: 'Pro',
					monthlyUsageDollars: 75,
					description: null,
					features: [],
					displayOrder: 100,
					highlighted: false,
					prices: { monthly: null, annual: null }
				}
			]
		});
	});

	it('returns cached prices for an arbitrary configured tier', async () => {
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		const t = initConvexTest();
		const now = Date.now();

		const prices = await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				monthly: 75 * MODEL_USAGE_UNITS_PER_DOLLAR,
				monthlyProductId: 'prod_team_monthly',
				annualProductId: 'prod_team_annual'
			});

			const prices = {
				monthly: {
					productId: 'prod_team_monthly',
					name: 'Team Monthly',
					amountMinor: 2_000,
					currency: 'USD',
					paymentFrequencyCount: 1,
					paymentFrequencyInterval: 'Month'
				},
				annual: {
					productId: 'prod_team_annual',
					name: 'Team Annual',
					amountMinor: 20_000,
					currency: 'USD',
					paymentFrequencyCount: 1,
					paymentFrequencyInterval: 'Year'
				}
			};

			for (const price of Object.values(prices)) {
				await ctx.db.insert('dodoPricingCache', {
					environment: 'test_mode',
					productId: price.productId,
					price,
					validatedAt: now,
					expiresAt: now + 60_000
				});
			}

			return prices;
		});

		const catalog = await t.action(api.pricing.getPublicCatalog, {});
		expect(catalog.plans[0]?.prices).toEqual(prices);
	});

	it('coalesces cold-cache refreshes through the lease and skips provider calls', async () => {
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		const t = initConvexTest();

		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				monthly: 1,
				monthlyProductId: 'prod_held'
			});
		});

		const now = Date.now();
		await t.mutation(internal.pricingData.acquireProductRefreshLease, {
			environment: 'test_mode',
			productId: 'prod_held',
			leaseOwner: 'other-instance',
			leaseExpiresAt: now + 60_000,
			now
		});

		let fetches = 0;

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				fetches += 1;
				throw new Error('must not fetch under a held lease');
			})
		);

		const catalog = await t.action(api.pricing.getPublicCatalog, {});

		expect(fetches).toBe(0);
		expect(catalog.plans.find((plan) => plan.id === 'pro')?.prices.monthly).toBeNull();
	});

	it('negative-caches invalid products instead of refetching every request', async () => {
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		const t = initConvexTest();

		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				monthly: 1,
				monthlyProductId: 'prod_onetime'
			});
		});

		let fetches = 0;

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				fetches += 1;

				return Response.json({
					product_id: 'prod_onetime',
					name: 'One-time',
					price: { type: 'one_time_price', price: 2_000, currency: 'USD' }
				});
			})
		);

		const first = await t.action(api.pricing.getPublicCatalog, {});

		expect(first.plans.find((plan) => plan.id === 'pro')?.prices.monthly).toBeNull();
		expect(fetches).toBe(1);

		const second = await t.action(api.pricing.getPublicCatalog, {});

		expect(second.plans.find((plan) => plan.id === 'pro')?.prices.monthly).toBeNull();
		expect(fetches).toBe(1);
	});

	it('persists healthy prices per product when another product fails', async () => {
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		const t = initConvexTest();

		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				monthly: 1,
				monthlyProductId: 'prod_ok'
			});
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				monthly: 1,
				monthlyProductId: 'prod_down'
			});
		});

		vi.stubGlobal(
			'fetch',
			vi.fn(async (request: Request | string | URL) => {
				const productId = new URL(
					request instanceof Request ? request.url : String(request)
				).pathname
					.split('/')
					.at(-1);

				if (productId === 'prod_down') return new Response('down', { status: 500 });

				return Response.json({
					product_id: productId,
					name: 'Team',
					price: {
						type: 'recurring_price',
						price: 5_000,
						currency: 'USD',
						payment_frequency_count: 1,
						payment_frequency_interval: 'Month'
					}
				});
			})
		);

		const catalog = await t.action(api.pricing.getPublicCatalog, {});

		expect(catalog.plans.find((plan) => plan.id === 'team')?.prices.monthly).toMatchObject({
			productId: 'prod_ok',
			amountMinor: 5_000
		});
		expect(catalog.plans.find((plan) => plan.id === 'pro')?.prices.monthly).toBeNull();

		const again = await t.action(api.pricing.getPublicCatalog, {});

		expect(again.plans.find((plan) => plan.id === 'team')?.prices.monthly).toMatchObject({
			productId: 'prod_ok'
		});
	});

	it('bounds concurrent cold-cache refreshes to the global lease budget', async () => {
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const t = initConvexTest();

		await t.run(async (ctx) => {
			for (let i = 0; i < DODO_FETCH_BUDGET_PER_OPERATION + 4; i++) {
				await ctx.db.insert('tiers', {
					tierId: `tier_${i}`,
					label: `Tier ${i}`,
					monthly: 1,
					monthlyProductId: `prod_cold_${i}`
				});
			}
		});

		let activeFetches = 0;
		let maxActiveFetches = 0;
		const fetched: string[] = [];
		const gates = new Map<string, () => void>();

		vi.stubGlobal(
			'fetch',
			vi.fn(async (request: Request | string | URL) => {
				const productId =
					new URL(request instanceof Request ? request.url : String(request)).pathname
						.split('/')
						.at(-1) ?? '';

				fetched.push(productId);
				activeFetches += 1;
				maxActiveFetches = Math.max(maxActiveFetches, activeFetches);

				await new Promise<void>((resolve) => {
					gates.set(productId, resolve);
				});
				activeFetches -= 1;

				return Response.json({
					product_id: productId,
					name: productId,
					price: {
						type: 'recurring_price',
						price: 1_000,
						currency: 'USD',
						payment_frequency_count: 1,
						payment_frequency_interval: 'Month'
					}
				});
			})
		);

		const pendingCatalog = t.action(api.pricing.getPublicCatalog, {});

		await vi.waitFor(() => {
			expect(activeFetches).toBe(DODO_FETCH_CONCURRENCY);
		});

		while (gates.size > 0) {
			const openGate = gates.keys().next().value;

			if (openGate === undefined) break;

			const inFlightBeforeRelease = activeFetches;
			const fetchedBeforeRelease = fetched.length;
			gates.get(openGate)?.();
			gates.delete(openGate);

			if (fetchedBeforeRelease < DODO_FETCH_BUDGET_PER_OPERATION) {
				await vi.waitFor(() => {
					expect(fetched.length).toBe(fetchedBeforeRelease + 1);
					expect(activeFetches).toBe(inFlightBeforeRelease);
				});
			} else {
				await vi.waitFor(() => {
					expect(fetched.length).toBe(DODO_FETCH_BUDGET_PER_OPERATION);
					expect(activeFetches).toBe(inFlightBeforeRelease - 1);
				});
			}
		}

		const catalog = await pendingCatalog;

		expect(fetched.length).toBe(DODO_FETCH_BUDGET_PER_OPERATION);
		expect(maxActiveFetches).toBe(DODO_FETCH_CONCURRENCY);

		const withPrices = catalog.plans.filter((plan) => plan.prices.monthly !== null);
		expect(withPrices.length).toBe(DODO_FETCH_BUDGET_PER_OPERATION);
	});

	it('enforces the durable global refresh budget across instances', async () => {
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const t = initConvexTest();
		const now = Date.now();

		await t.run(async (ctx) => {
			for (let i = 0; i < 8; i++) {
				await ctx.db.insert('dodoPricingCache', {
					environment: 'test_mode',
					productId: `prod_held_${i}`,
					expiresAt: 0,
					leaseOwner: `other-instance-${i}`,
					leaseExpiresAt: now + 60_000
				});
			}

			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				monthly: 1,
				monthlyProductId: 'prod_blocked'
			});
		});

		let fetches = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				fetches += 1;
				throw new Error('must not fetch past the durable global budget');
			})
		);

		const catalog = await t.action(api.pricing.getPublicCatalog, {});

		expect(fetches).toBe(0);
		expect(catalog.plans.find((plan) => plan.id === 'pro')?.prices.monthly).toBeNull();

		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('dodoPricingCache')
				.withIndex('by_environment_and_productId', (query) =>
					query.eq('environment', 'test_mode').eq('productId', 'prod_blocked')
				)
				.collect()
		);

		expect(rows).toEqual([]);

		vi.setSystemTime(now + 61_000);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({
					product_id: 'prod_blocked',
					name: 'Pro',
					price: {
						type: 'recurring_price',
						price: 3_000,
						currency: 'USD',
						payment_frequency_count: 1,
						payment_frequency_interval: 'Month'
					}
				})
			)
		);

		const recovered = await t.action(api.pricing.getPublicCatalog, {});

		expect(recovered.plans.find((plan) => plan.id === 'pro')?.prices.monthly).toMatchObject({
			productId: 'prod_blocked',
			amountMinor: 3_000
		});
	});
});
