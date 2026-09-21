import { v } from 'convex/values';
import { internalQuery } from '@convex/_generated/server';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';

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
