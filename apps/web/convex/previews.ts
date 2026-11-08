import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';

// The Dodo test-mode one-time product that the dev deployment sells as its $5 pack.
const TEST_CREDIT_PACK_PRODUCT_ID = 'pdt_0NrRZWomwpywav5q13T1k';

const TIERS = [
	{ tierId: 'free', label: 'Free', dollars: 5 },
	{ tierId: 'lite', label: 'Lite', dollars: 20 },
	{ tierId: 'pro', label: 'Pro', dollars: 100 },
	{ tierId: 'ultra', label: 'Ultra', dollars: 300 }
];

/** Seeds the pricing catalog of a new preview deployment, through `convex deploy --preview-run`. */
export const seed = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		if (await ctx.db.query('tiers').first()) {
			throw new Error('Only empty preview deployments can be seeded.');
		}

		for (const { tierId, label, dollars } of TIERS) {
			await ctx.db.insert('tiers', {
				tierId,
				label,
				monthly: dollars * MODEL_USAGE_UNITS_PER_DOLLAR
			});
		}

		await ctx.db.insert('creditPacks', {
			productId: TEST_CREDIT_PACK_PRODUCT_ID,
			units: 5 * MODEL_USAGE_UNITS_PER_DOLLAR,
			expiresAfter: { count: 30, unit: 'day' }
		});
		// The pack is sellable once the price sync confirms its Dodo price.
		await ctx.scheduler.runAfter(0, internal.dodo.syncPrices, {});

		return null;
	}
});
