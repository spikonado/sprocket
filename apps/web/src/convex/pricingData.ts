import { v } from 'convex/values';
import { internalMutation, internalQuery } from '@convex/_generated/server';
import { vDodoProPrices, vDodoPublicPrice } from '@convex/lib/dodoProducts';
import { MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';

const vTierPrice = v.object({
	tierId: v.string(),
	interval: v.union(v.literal('monthly'), v.literal('annual')),
	price: vDodoPublicPrice
});

export const getCachedTierPrices = internalQuery({
	args: { cacheKey: v.string(), now: v.number() },
	returns: v.union(v.array(vTierPrice), v.null()),
	handler: async (ctx, { cacheKey, now }) => {
		const cached = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_cacheKey', (query) => query.eq('cacheKey', cacheKey))
			.unique();
		return cached?.tierPrices && cached.expiresAt > now ? cached.tierPrices : null;
	}
});

export const cacheTierPrices = internalMutation({
	args: { cacheKey: v.string(), tierPrices: v.array(vTierPrice), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const cached = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_cacheKey', (query) => query.eq('cacheKey', args.cacheKey))
			.unique();
		if (cached) await ctx.db.patch(cached._id, args);
		else await ctx.db.insert('dodoPricingCache', args);
		return null;
	}
});

export const getCachedDodoPrices = internalQuery({
	args: { cacheKey: v.string(), now: v.number() },
	returns: v.union(vDodoProPrices, v.null()),
	handler: async (ctx, { cacheKey, now }) => {
		const cached = await ctx.db
			.query('dodoPricingCache')
			.withIndex('by_cacheKey', (query) => query.eq('cacheKey', cacheKey))
			.unique();
		return cached?.proPrices && cached.expiresAt > now ? cached.proPrices : null;
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
			id: v.string(),
			label: v.string(),
			weeklyUsageDollars: v.number(),
			monthlyUsageDollars: v.number(),
			description: v.union(v.string(), v.null()),
			features: v.array(v.string()),
			displayOrder: v.number(),
			highlighted: v.boolean(),
			monthlyProductId: v.union(v.string(), v.null()),
			annualProductId: v.union(v.string(), v.null())
		})
	),
	handler: async (ctx) => {
		const tiers = await ctx.db.query('tiers').collect();
		const seen = new Set<string>();
		const plans = tiers.map((tier) => {
			if (seen.has(tier.tierId)) throw new Error(`Duplicate tiers rows for tier "${tier.tierId}".`);
			seen.add(tier.tierId);
			return {
				id: tier.tierId,
				label: tier.label,
				weeklyUsageDollars: tier.weekly / MODEL_USAGE_UNITS_PER_DOLLAR,
				monthlyUsageDollars: tier.monthly / MODEL_USAGE_UNITS_PER_DOLLAR,
				description: tier.description ?? null,
				features: tier.features ?? [],
				displayOrder: tier.displayOrder ?? (tier.tierId === 'free' ? 0 : 100),
				highlighted: tier.highlighted ?? false,
				monthlyProductId: tier.monthlyProductId ?? null,
				annualProductId: tier.annualProductId ?? null
			};
		});
		return plans.sort(
			(left, right) =>
				left.displayOrder - right.displayOrder ||
				left.label.localeCompare(right.label) ||
				left.id.localeCompare(right.id)
		);
	}
});

export const getTierProduct = internalQuery({
	args: {
		tierId: v.string(),
		interval: v.union(v.literal('monthly'), v.literal('annual'))
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { tierId, interval }) => {
		const rows = await ctx.db
			.query('tiers')
			.withIndex('by_tierId', (query) => query.eq('tierId', tierId))
			.take(2);
		if (rows.length > 1) throw new Error(`Duplicate tiers rows for tier "${tierId}".`);
		const tier = rows[0];
		if (!tier) return null;
		const productId = interval === 'monthly' ? tier.monthlyProductId : tier.annualProductId;
		if (!productId) return null;
		const [monthly, annual] = await Promise.all([
			ctx.db
				.query('tiers')
				.withIndex('by_monthlyProductId', (query) => query.eq('monthlyProductId', productId))
				.take(2),
			ctx.db
				.query('tiers')
				.withIndex('by_annualProductId', (query) => query.eq('annualProductId', productId))
				.take(2)
		]);
		if (monthly.length + annual.length !== 1) {
			throw new Error(`Dodo product "${productId}" is assigned more than once.`);
		}
		return productId;
	}
});

export const getTierForProduct = internalQuery({
	args: { productId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { productId }) => {
		const [monthly, annual] = await Promise.all([
			ctx.db
				.query('tiers')
				.withIndex('by_monthlyProductId', (query) => query.eq('monthlyProductId', productId))
				.take(2),
			ctx.db
				.query('tiers')
				.withIndex('by_annualProductId', (query) => query.eq('annualProductId', productId))
				.take(2)
		]);
		const assignments = [...monthly, ...annual];
		if (assignments.length > 1) {
			throw new Error(`Dodo product "${productId}" is assigned more than once.`);
		}
		return assignments[0]?.tierId ?? null;
	}
});
