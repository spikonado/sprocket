import { afterEach, describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import { initConvexTest } from './test.setup';

const originalApiKey = process.env.DODO_PAYMENTS_API_KEY;

afterEach(() => {
	if (originalApiKey === undefined) delete process.env.DODO_PAYMENTS_API_KEY;
	else process.env.DODO_PAYMENTS_API_KEY = originalApiKey;
});

describe('public pricing catalog', () => {
	it('caches Dodo prices until their expiration', async () => {
		const t = initConvexTest();
		const proPrices = {
			monthly: {
				productId: 'prod_monthly',
				name: 'Pro Monthly',
				amountMinor: 2_000,
				currency: 'USD',
				paymentFrequencyCount: 1,
				paymentFrequencyInterval: 'Month'
			},
			annual: {
				productId: 'prod_annual',
				name: 'Pro Annual',
				amountMinor: 20_000,
				currency: 'USD',
				paymentFrequencyCount: 1,
				paymentFrequencyInterval: 'Year'
			}
		};
		await t.mutation(internal.pricingData.cacheDodoPrices, {
			cacheKey: 'test:monthly:annual',
			proPrices,
			expiresAt: 2_000
		});

		await expect(
			t.query(internal.pricingData.getCachedDodoPrices, {
				cacheKey: 'test:monthly:annual',
				now: 1_999
			})
		).resolves.toEqual(proPrices);
		await expect(
			t.query(internal.pricingData.getCachedDodoPrices, {
				cacheKey: 'test:monthly:annual',
				now: 2_000
			})
		).resolves.toBeNull();
	});

	it('returns current Free and Pro allowances when Dodo is not configured', async () => {
		delete process.env.DODO_PAYMENTS_API_KEY;
		const t = initConvexTest();
		await t.run(async (ctx) => {
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
				{ id: 'free', label: 'Free', monthlyUsageDollars: 15 },
				{ id: 'pro', label: 'Pro', monthlyUsageDollars: 75 }
			],
			proPrices: null
		});
	});
});
