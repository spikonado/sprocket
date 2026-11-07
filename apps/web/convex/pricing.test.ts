import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import { initConvexTest } from './test.setup';

function usdPrice(productId: string, amountMinor: number, interval: 'Month' | 'Year') {
	return {
		productId,
		name: null,
		amountMinor,
		currency: 'USD',
		paymentFrequencyCount: 1,
		paymentFrequencyInterval: interval
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('public pricing catalog', () => {
	it('returns every tier in card order with card defaults and no stale prices', async () => {
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
				monthlyProductId: 'prod_team_monthly',
				monthlyPrice: usdPrice('prod_team_previous', 2_000, 'Month')
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

	it('syncs Dodo prices onto tiers and keeps the last price when Dodo fails', async () => {
		vi.stubEnv('DODO_PAYMENTS_API_KEY', 'test_key');
		vi.stubEnv('DODO_PAYMENTS_ENVIRONMENT', 'test_mode');
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const products = new Map([
			['prod_monthly', { price: 2_000, interval: 'Month' }],
			['prod_annual', { price: 20_000, interval: 'Year' }],
			['prod_wrong_interval', { price: 2_000, interval: 'Month' }]
		]);

		vi.stubGlobal('fetch', async (input: Request | string | URL) => {
			const productId = new URL(input instanceof Request ? input.url : String(input)).pathname
				.split('/')
				.at(-1);

			const product = products.get(productId ?? '');

			if (!product) return Response.json({ message: 'Unavailable' }, { status: 400 });

			return Response.json({
				product_id: productId,
				price: {
					type: 'recurring_price',
					price: product.price,
					currency: 'USD',
					payment_frequency_count: 1,
					payment_frequency_interval: product.interval
				}
			});
		});
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert('tiers', {
				tierId: 'pro',
				label: 'Pro',
				monthly: 1,
				monthlyProductId: 'prod_monthly',
				annualProductId: 'prod_annual'
			});
			await ctx.db.insert('tiers', {
				tierId: 'max',
				label: 'Max',
				monthly: 2,
				annualProductId: 'prod_wrong_interval',
				annualPrice: usdPrice('prod_wrong_interval', 1, 'Year')
			});
		});

		await t.action(internal.dodo.syncPrices, {});
		products.delete('prod_annual');
		await t.action(internal.dodo.syncPrices, {});

		const { plans } = await t.action(api.pricing.getPublicCatalog, {});
		expect(plans.map(({ id, prices }) => ({ id, prices }))).toEqual([
			{ id: 'max', prices: { monthly: null, annual: null } },
			{
				id: 'pro',
				prices: {
					monthly: usdPrice('prod_monthly', 2_000, 'Month'),
					annual: usdPrice('prod_annual', 20_000, 'Year')
				}
			}
		]);
	});
});
