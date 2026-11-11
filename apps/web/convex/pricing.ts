import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from '@convex/_generated/server';
import {
	vPrice,
	vPublicPricingCatalog,
	type PublicPricingCatalog
} from '@convex/lib/pricingValidators';
import { assertSingleTierSells, getTierRow, MODEL_USAGE_UNITS_PER_DOLLAR } from '@convex/lib/tiers';
import { vBillingInterval } from '@convex/lib/validators';

export function priceForProduct<T extends { productId: string }>(
	productId: string | undefined,
	price: T | undefined
): T | null {
	return price && price.productId === productId ? price : null;
}

export const getPublicCatalog = query({
	args: {},
	returns: vPublicPricingCatalog,
	handler: async (ctx): Promise<PublicPricingCatalog> => {
		const tiers = await ctx.db.query('tiers').collect();
		const seen = new Set<string>();

		const plans = tiers.map((tier) => {
			if (seen.has(tier.tierId)) throw new Error(`Duplicate tiers rows for tier "${tier.tierId}".`);
			seen.add(tier.tierId);

			return {
				id: tier.tierId,
				label: tier.label,
				monthlyUsageDollars: tier.monthly / MODEL_USAGE_UNITS_PER_DOLLAR,
				description: tier.description ?? null,
				features: tier.features ?? [],
				displayOrder: tier.displayOrder ?? (tier.tierId === 'free' ? 0 : 100),
				highlighted: tier.highlighted ?? false,
				prices: {
					monthly: priceForProduct(tier.monthlyProductId, tier.monthlyPrice),
					annual: priceForProduct(tier.annualProductId, tier.annualPrice)
				}
			};
		});

		plans.sort(
			(left, right) =>
				left.displayOrder - right.displayOrder ||
				left.label.localeCompare(right.label) ||
				left.id.localeCompare(right.id)
		);

		const packs = await ctx.db.query('creditPacks').collect();

		packs.sort(
			(left, right) => left.units - right.units || left.productId.localeCompare(right.productId)
		);

		const creditPacks = packs.map((pack) => ({
			productId: pack.productId,
			usageDollars: pack.units / MODEL_USAGE_UNITS_PER_DOLLAR,
			expiresAfter: pack.expiresAfter,
			price: priceForProduct(pack.productId, pack.price)
		}));

		return { plans, creditPacks };
	}
});

export const getTierProduct = internalQuery({
	args: { tierId: v.string(), interval: vBillingInterval },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, { tierId, interval }) => {
		const tier = await getTierRow(ctx, tierId);
		const productId = interval === 'monthly' ? tier?.monthlyProductId : tier?.annualProductId;

		if (!productId) return null;

		await assertSingleTierSells(ctx, productId);

		return productId;
	}
});

export const listTierProducts = internalQuery({
	args: {},
	returns: v.array(
		v.object({ tierId: v.string(), interval: vBillingInterval, productId: v.string() })
	),
	handler: async (ctx) => {
		const tiers = await ctx.db.query('tiers').collect();

		return tiers.flatMap(({ tierId, monthlyProductId, annualProductId }) => [
			...(monthlyProductId
				? [{ tierId, interval: 'monthly' as const, productId: monthlyProductId }]
				: []),
			...(annualProductId
				? [{ tierId, interval: 'annual' as const, productId: annualProductId }]
				: [])
		]);
	}
});

export const setTierPrice = internalMutation({
	args: {
		tierId: v.string(),
		interval: vBillingInterval,
		price: v.union(vPrice, v.null())
	},
	returns: v.null(),
	handler: async (ctx, { tierId, interval, price }) => {
		const tier = await getTierRow(ctx, tierId);

		if (!tier) return null;

		const stored = price ?? undefined;
		await ctx.db.patch(
			'tiers',
			tier._id,
			interval === 'monthly' ? { monthlyPrice: stored } : { annualPrice: stored }
		);

		return null;
	}
});
