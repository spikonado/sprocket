import { afterEach, describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import { initConvexTest } from './test.setup';

const ENV_KEYS = [
	'DODO_PAYMENTS_API_KEY',
	'DODO_PAYMENTS_ENVIRONMENT',
	'DODO_PAYMENTS_PRO_MONTHLY_PRODUCT_ID',
	'DODO_PAYMENTS_PRO_ANNUAL_PRODUCT_ID'
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe('public pricing catalog', () => {
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
		for (const key of ENV_KEYS) delete process.env[key];
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
			],
			proPrices: null
		});
	});

	it('returns cached prices for an arbitrary configured tier', async () => {
		process.env.DODO_PAYMENTS_API_KEY = 'test_key';
		process.env.DODO_PAYMENTS_ENVIRONMENT = 'test_mode';
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
		expect(catalog.proPrices).toBeNull();
	});

	it('uses legacy Pro product environment variables during migration', async () => {
		process.env.DODO_PAYMENTS_API_KEY = 'test_key';
		process.env.DODO_PAYMENTS_ENVIRONMENT = 'test_mode';
		process.env.DODO_PAYMENTS_PRO_MONTHLY_PRODUCT_ID = 'prod_pro_monthly';
		process.env.DODO_PAYMENTS_PRO_ANNUAL_PRODUCT_ID = 'prod_pro_annual';
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				weekly: 25 * MODEL_USAGE_UNITS_PER_DOLLAR,
				monthly: 75 * MODEL_USAGE_UNITS_PER_DOLLAR
			});
		});
		const monthly = {
			productId: 'prod_pro_monthly',
			name: 'Pro Monthly',
			amountMinor: 2_000,
			currency: 'USD',
			paymentFrequencyCount: 1,
			paymentFrequencyInterval: 'Month'
		};
		const annual = {
			productId: 'prod_pro_annual',
			name: 'Pro Annual',
			amountMinor: 20_000,
			currency: 'USD',
			paymentFrequencyCount: 1,
			paymentFrequencyInterval: 'Year'
		};
		await t.mutation(internal.pricingData.cacheTierPrices, {
			cacheKey: 'test_mode:pro:annual:prod_pro_annual|pro:monthly:prod_pro_monthly',
			tierPrices: [
				{ tierId: 'pro', interval: 'monthly', price: monthly },
				{ tierId: 'pro', interval: 'annual', price: annual }
			],
			expiresAt: Date.now() + 60_000
		});

		const catalog = await t.action(api.pricing.getPublicCatalog, {});
		expect(catalog.plans[0]?.prices).toEqual({ monthly, annual });
		expect(catalog.proPrices).toEqual({ monthly, annual });
	});
});
