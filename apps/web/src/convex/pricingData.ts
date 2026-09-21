import { v } from 'convex/values';
import { internalMutation, internalQuery } from '@convex/_generated/server';
import { vDodoProPrices } from '@convex/lib/dodoProducts';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';

export const getCachedDodoPrices = internalQuery({
	args: { cacheKey: v.string(), now: v.number() },
	returns: v.union(vDodoProPrices, v.null()),
	handler: async (ctx, { cacheKey, now }) => {
		const cached = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_cacheKey', (query) => query.eq('cacheKey', cacheKey))
			.unique();
		return cached && cached.expiresAt > now ? cached.proPrices : null;
	}
});

export const cacheDodoPrices = internalMutation({
	args: {
		cacheKey: v.string(),
		proPrices: vDodoProPrices,
		expiresAt: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const cached = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_cacheKey', (query) => query.eq('cacheKey', args.cacheKey))
			.unique();
		if (cached) await ctx.db.replace(cached._id, args);
		else await ctx.db.insert('dodoPricingCache', args);
		return null;
	}
});

export const getPublicPlans = internalQuery({
	args: {},
	returns: v.array(
		v.object({
			id: v.union(v.literal('free'), v.literal('pro')),
			label: v.string(),
			monthlyUsageDollars: v.number()
		})
	),
	handler: async (ctx) => {
		const plans = await Promise.all(
			(['free', 'pro'] as const).map(async (id) => {
				const tier = await ctx.db
					.query('tiers')
					.withIndex('by_tierId', (query) => query.eq('tierId', id))
					.unique();
				if (!tier) throw new Error(`Pricing tier "${id}" is not configured.`);
				return {
					id,
					label: tier.label,
					monthlyUsageDollars: tier.monthly / MODEL_USAGE_UNITS_PER_DOLLAR
				};
			})
		);
		return plans;
	}
});
