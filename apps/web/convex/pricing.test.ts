import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import { initConvexTest } from './test.setup';

const ENV_KEYS = ['DODO_PAYMENTS_API_KEY', 'DODO_PAYMENTS_ENVIRONMENT'] as const;

afterEach(() => {
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
			vi.stubGlobal(
				'fetch',
				vi.fn(async (request: Request | string | URL) => {
					const url = new URL(request instanceof Request ? request.url : String(request));
					const productId = url.pathname.split('/').at(-1);

					if (productId === 'prod_broken' && failure === 'request') {
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
							payment_frequency_interval: productId === 'prod_broken' ? 'Year' : 'Month'
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
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'team',
				label: 'Team',
				weekly: 25 * MODEL_USAGE_UNITS_PER_DOLLAR,
				monthly: 75 * MODEL_USAGE_UNITS_PER_DOLLAR,
				monthlyProductId: 'prod_team_monthly',
				annualProductId: 'prod_team_annual'
			});
		});

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

		await t.mutation(internal.pricingData.cacheTierPrices, {
			cacheKey: 'test_mode:team:annual:prod_team_annual|team:monthly:prod_team_monthly',
			tierPrices,
			expiresAt: Date.now() + 60_000
		});

		const catalog = await t.action(api.pricing.getPublicCatalog, {});
		expect(catalog.plans[0]?.prices).toEqual({
			monthly: tierPrices[0]?.price,
			annual: tierPrices[1]?.price
		});
	});
});
