import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { action, internalMutation, internalQuery } from '@convex/_generated/server';
import {
	vPrice,
	vPublicPricingCatalog,
	type PublicPricingCatalog
} from '@convex/lib/pricingValidators';
import { getTierRow, MODEL_USAGE_UNITS_PER_DOLLAR, tierForProduct } from '@convex/lib/tiers';
import { vBillingInterval } from '@convex/lib/validators';

/** Hides a price synced for a product the tier no longer sells. */
function currentPrice<T extends { productId: string }>(
	productId: string | undefined,
	price: T | undefined
): T | null {
	return price && price.productId === productId ? price : null;
}

export const getPublicCatalog = action({
	args: {},
	returns: vPublicPricingCatalog,
	handler: (ctx): Promise<PublicPricingCatalog> => ctx.runQuery(internal.pricing.getCatalog, {})
});

export const getCatalog = internalQuery({
	args: {},
	returns: vPublicPricingCatalog,
	handler: async (ctx) => {
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
					monthly: currentPrice(tier.monthlyProductId, tier.monthlyPrice),
					annual: currentPrice(tier.annualProductId, tier.annualPrice)
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
			label: pack.label,
			usageDollars: pack.units / MODEL_USAGE_UNITS_PER_DOLLAR,
			expiresAfterDays: pack.expiresAfterDays,
			price: currentPrice(pack.productId, pack.price)
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

		// Throws when another tier also sells this product.
		await tierForProduct(ctx, productId);

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
