import { v, type Infer } from 'convex/values';
import { vDodoPublicPrice } from '@convex/lib/dodoProducts';
import { vBillingInterval } from '@convex/lib/validators';

export const vTierPrice = v.object({
	tierId: v.string(),
	interval: vBillingInterval,
	price: vDodoPublicPrice
});

export const vPublicPricingPlan = v.object({
	id: v.string(),
	label: v.string(),
	weeklyUsageDollars: v.number(),
	monthlyUsageDollars: v.number(),
	description: v.union(v.string(), v.null()),
	features: v.array(v.string()),
	displayOrder: v.number(),
	highlighted: v.boolean(),
	prices: v.object({
		monthly: v.union(vDodoPublicPrice, v.null()),
		annual: v.union(vDodoPublicPrice, v.null())
	})
});

export type PublicPricingPlan = Infer<typeof vPublicPricingPlan>;

export const vPublicPricingCatalog = v.object({
	plans: v.array(vPublicPricingPlan)
});

export type PublicPricingCatalog = Infer<typeof vPublicPricingCatalog>;

export const vTierPricingConfig = vPublicPricingPlan.omit('prices').extend({
	monthlyProductId: v.union(v.string(), v.null()),
	annualProductId: v.union(v.string(), v.null())
});

export type TierPricingConfig = Infer<typeof vTierPricingConfig>;
