import { v, type Infer } from 'convex/values';

export const billingIntervalIds = ['monthly', 'annual'] as const;
export type BillingInterval = (typeof billingIntervalIds)[number];

export const vDodoPublicPrice = v.object({
	productId: v.string(),
	name: v.union(v.string(), v.null()),
	amountMinor: v.number(),
	currency: v.string(),
	paymentFrequencyCount: v.number(),
	paymentFrequencyInterval: v.string()
});

export const vDodoProPrices = v.object({
	monthly: vDodoPublicPrice,
	annual: vDodoPublicPrice
});
export type DodoProPrices = Infer<typeof vDodoProPrices>;

export type ProProductIds = {
	monthly?: string;
	annual?: string;
};
export type DodoEnvironment = 'test_mode' | 'live_mode';

type DodoProductEnv = {
	DODO_PAYMENTS_PRO_MONTHLY_PRODUCT_ID?: string;
	DODO_PAYMENTS_PRO_ANNUAL_PRODUCT_ID?: string;
};

export function readProProductIds(env: DodoProductEnv = process.env): ProProductIds {
	const monthly = env.DODO_PAYMENTS_PRO_MONTHLY_PRODUCT_ID?.trim();
	const annual = env.DODO_PAYMENTS_PRO_ANNUAL_PRODUCT_ID?.trim();
	const products: ProProductIds = {};
	if (monthly) products.monthly = monthly;
	if (annual) products.annual = annual;
	return products;
}

export function readDodoEnvironment(
	env: { DODO_PAYMENTS_ENVIRONMENT?: string } = process.env
): DodoEnvironment {
	const value = env.DODO_PAYMENTS_ENVIRONMENT?.trim() || 'test_mode';
	if (value !== 'test_mode' && value !== 'live_mode') {
		throw new Error('DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode.');
	}
	return value;
}

export function productIdForCheckout(
	tier: string,
	interval: BillingInterval,
	products: ProProductIds = readProProductIds()
): string | undefined {
	return tier === 'pro' ? products[interval] : undefined;
}

export function tierForProductId(
	productId: string,
	products: ProProductIds = readProProductIds()
): 'pro' | undefined {
	return billingIntervalIds.some((interval) => products[interval] === productId)
		? 'pro'
		: undefined;
}

export function matchesBillingInterval(
	interval: BillingInterval,
	paymentFrequencyCount: number,
	paymentFrequencyInterval: string
): boolean {
	if (interval === 'monthly') {
		return paymentFrequencyCount === 1 && paymentFrequencyInterval === 'Month';
	}
	return (
		(paymentFrequencyCount === 1 && paymentFrequencyInterval === 'Year') ||
		(paymentFrequencyCount === 12 && paymentFrequencyInterval === 'Month')
	);
}
