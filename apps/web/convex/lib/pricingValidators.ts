import { v, type Infer } from 'convex/values';

export const vPrice = v.object({
	productId: v.string(),
	name: v.union(v.string(), v.null()),
	amountMinor: v.number(),
	currency: v.string(),
	paymentFrequencyCount: v.number(),
	paymentFrequencyInterval: v.string()
});

export type Price = Infer<typeof vPrice>;

export const vPublicPricingPlan = v.object({
	id: v.string(),
	label: v.string(),
	monthlyUsageDollars: v.number(),
	description: v.union(v.string(), v.null()),
	features: v.array(v.string()),
	displayOrder: v.number(),
	highlighted: v.boolean(),
	prices: v.object({
		monthly: v.union(vPrice, v.null()),
		annual: v.union(vPrice, v.null())
	})
});

export type PublicPricingPlan = Infer<typeof vPublicPricingPlan>;

export const vPublicPricingCatalog = v.object({
	plans: v.array(vPublicPricingPlan)
});

export type PublicPricingCatalog = Infer<typeof vPublicPricingCatalog>;
