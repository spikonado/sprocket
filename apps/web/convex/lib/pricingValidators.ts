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

export const vPackPrice = v.object({
	productId: v.string(),
	amountMinor: v.number(),
	currency: v.string()
});

export type PackPrice = Infer<typeof vPackPrice>;

export const vCreditPackExpiry = v.object({
	count: v.number(),
	unit: v.union(v.literal('day'), v.literal('month'), v.literal('year'))
});

export type CreditPackExpiry = Infer<typeof vCreditPackExpiry>;

/** What a buyer gets, recorded at checkout. */
export const vCreditPackTerms = v.object({ units: v.number(), expiresAfter: vCreditPackExpiry });

export type CreditPackTerms = Infer<typeof vCreditPackTerms>;

export const vCheckoutPurchase = v.union(
	v.object({ kind: v.literal('subscription') }),
	v.object({ kind: v.literal('creditPack'), terms: vCreditPackTerms })
);

export type CheckoutPurchase = Infer<typeof vCheckoutPurchase>;

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

export const vPublicCreditPack = v.object({
	productId: v.string(),
	usageDollars: v.number(),
	expiresAfter: vCreditPackExpiry,
	price: v.union(vPackPrice, v.null())
});

export const vPublicPricingCatalog = v.object({
	plans: v.array(vPublicPricingPlan),
	creditPacks: v.array(vPublicCreditPack)
});

export type PublicPricingCatalog = Infer<typeof vPublicPricingCatalog>;
