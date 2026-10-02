import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
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
					weekly: 1,
					monthly: 1,
					monthlyProductId: 'prod_healthy',
					annualProductId: failure === 'assignment' ? 'prod_broken' : undefined
				});
				await ctx.db.insert('tiers', {
					tierId: 'pro',
					label: 'Pro',
					weekly: 1,
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
				// Advance past the 30s transient backoff so the lease allows a retry.
				vi.setSystemTime(Date.now() + 31_000);
				const recoveredCatalog = await t.action(api.pricing.getPublicCatalog, {});

				expect(
					recoveredCatalog.plans.find((plan) => plan.id === 'pro')?.prices.monthly
				).toMatchObject({ productId: 'prod_broken', amountMinor: 2_000 });
			}
		}
	);

	it('caches Dodo prices until their expiration', async () => {
		const t = initConvexTest();

		const tierPrices = [
			{
				tierId: 'team',
				interval: 'monthly' as const,
				price: {
					productId: 'prod_monthly',
					name: 'Team Monthly',
					amountMinor: 2_000,
					currency: 'USD',
					paymentFrequencyCount: 1,
					paymentFrequencyInterval: 'Month'
				}
			},
			{
				tierId: 'team',
				interval: 'annual' as const,
				price: {
					productId: 'prod_annual',
					name: 'Team Annual',
					amountMinor: 20_000,
					currency: 'USD',
					paymentFrequencyCount: 1,
					paymentFrequencyInterval: 'Year'
				}
			}
		];

		await t.mutation(internal.pricingData.cacheTierPrices, {
			cacheKey: 'test:monthly:annual',
			tierPrices,
			expiresAt: 2_000
		});

		await expect(
			t.query(internal.pricingData.getCachedTierPrices, {
				cacheKey: 'test:monthly:annual',
				now: 1_999
			})
		).resolves.toEqual(tierPrices);
		await expect(
			t.query(internal.pricingData.getCachedTierPrices, {
				cacheKey: 'test:monthly:annual',
				now: 2_000
			})
		).resolves.toBeNull();
	});

	it('returns every tier in card order with card defaults when Dodo is not configured', async () => {
		for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				weekly: 30 * MODEL_USAGE_UNITS_PER_DOLLAR,
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
				weekly: 5 * MODEL_USAGE_UNITS_PER_DOLLAR,
				monthly: 15 * MODEL_USAGE_UNITS_PER_DOLLAR
			});
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				weekly: 25 * MODEL_USAGE_UNITS_PER_DOLLAR,
				monthly: 75 * MODEL_USAGE_UNITS_PER_DOLLAR
			});
		});

		await expect(t.action(api.pricing.getPublicCatalog, {})).resolves.toEqual({
			plans: [
				{
					id: 'free',
					label: 'Free',
					weeklyUsageDollars: 5,
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
					weeklyUsageDollars: 30,
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
					weeklyUsageDollars: 25,
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

		const tierPrices = await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				weekly: 25 * MODEL_USAGE_UNITS_PER_DOLLAR,
				monthly: 75 * MODEL_USAGE_UNITS_PER_DOLLAR,
				monthlyProductId: 'prod_team_monthly',
				annualProductId: 'prod_team_annual'
			});

			// Write the legacy aggregate row directly to simulate old data.
			const tierPrices = [
				{
					tierId: 'team',
					interval: 'monthly' as const,
					price: {
						productId: 'prod_team_monthly',
						name: 'Team Monthly',
						amountMinor: 2_000,
						currency: 'USD',
						paymentFrequencyCount: 1,
						paymentFrequencyInterval: 'Month'
					}
				},
				{
					tierId: 'team',
					interval: 'annual' as const,
					price: {
						productId: 'prod_team_annual',
						name: 'Team Annual',
						amountMinor: 20_000,
						currency: 'USD',
						paymentFrequencyCount: 1,
						paymentFrequencyInterval: 'Year'
					}
				}
			];

			await ctx.db.insert('dodoPricingCache', {
				cacheKey: 'test_mode:team:annual:prod_team_annual|team:monthly:prod_team_monthly',
				tierPrices,
				expiresAt: now + 60_000
			});

			return tierPrices;
		});

		const catalog = await t.action(api.pricing.getPublicCatalog, {});
		expect(catalog.plans[0]?.prices).toEqual({
			monthly: tierPrices[0]?.price,
			annual: tierPrices[1]?.price
		});
	});

	it('coalesces cold-cache refreshes through the lease and skips provider calls', async () => {
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		const t = initConvexTest();

		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				weekly: 1,
				monthly: 1,
				monthlyProductId: 'prod_held'
			});
		});

		// Another instance holds a live lease; no fetch may be attempted.
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
				weekly: 1,
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
				weekly: 1,
				monthly: 1,
				monthlyProductId: 'prod_ok'
			});
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				weekly: 1,
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

		// The healthy price persists per-product while the failed one is in
		// transient backoff, and the failed product is not refetched within the
		// retry window.
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

		// 12 distinct cold products; the per-operation fetch budget (8) means
		// at most 8 provider fetches happen, and the other 4 stay unfetched.
		await t.run(async (ctx) => {
			for (let i = 0; i < 12; i++) {
				await ctx.db.insert('tiers', {
					tierId: `tier_${i}`,
					label: `Tier ${i}`,
					weekly: 1,
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

				// Hold each fetch on an explicit gate so overlap is measured
				// deterministically without relying on timers.
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

		// Wait for the worker pool to saturate, then release one gate at a time;
		// each release must admit exactly one more fetch, proving the pool caps
		// concurrency instead of fanning out unbounded.
		await vi.waitFor(() => {
			expect(activeFetches).toBe(4);
		});

		while (gates.size > 0) {
			const openGate = gates.keys().next().value;

			if (openGate === undefined) break;

			const inFlightBeforeRelease = activeFetches;
			const fetchedBeforeRelease = fetched.length;
			gates.get(openGate)?.();
			gates.delete(openGate);

			if (fetchedBeforeRelease < 8) {
				await vi.waitFor(() => {
					expect(fetched.length).toBe(fetchedBeforeRelease + 1);
					expect(activeFetches).toBe(inFlightBeforeRelease);
				});
			} else {
				await vi.waitFor(() => {
					expect(fetched.length).toBe(8);
					expect(activeFetches).toBe(inFlightBeforeRelease - 1);
				});
			}
		}

		const catalog = await pendingCatalog;

		// Budget: at most 8 products refreshed; the rest stay null.
		expect(fetched.length).toBe(8);
		expect(maxActiveFetches).toBe(4);

		const withPrices = catalog.plans.filter((plan) => plan.prices.monthly !== null);
		expect(withPrices.length).toBe(8);
	});

	it('enforces the durable global refresh budget across instances', async () => {
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const t = initConvexTest();
		const now = Date.now();

		// Other instances already hold the full environment-wide lease budget;
		// rows without a lease remain claimable in principle.
		await t.run(async (ctx) => {
			for (let i = 0; i < 8; i++) {
				await ctx.db.insert('dodoPricingCache', {
					cacheKey: `test_mode:prod_held_${i}`,
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
				weekly: 1,
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

		// No row is created for a product whose claim the budget refused.
		const rows = await t.run(async (ctx) =>
			ctx.db
				.query('dodoPricingCache')
				.withIndex('by_environment_and_productId', (query) =>
					query.eq('environment', 'test_mode').eq('productId', 'prod_blocked')
				)
				.collect()
		);

		expect(rows).toEqual([]);

		// Once the other instances' leases lapse, the product refreshes
		// normally.
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
