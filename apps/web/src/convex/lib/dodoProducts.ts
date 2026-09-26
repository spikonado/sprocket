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
export type DodoPublicPrice = Infer<typeof vDodoPublicPrice>;
export type DodoEnvironment = 'test_mode' | 'live_mode';

export function readDodoEnvironment(
	env: { DODO_PAYMENTS_ENVIRONMENT?: string } = process.env
): DodoEnvironment {
	const value = env.DODO_PAYMENTS_ENVIRONMENT?.trim() || 'test_mode';
	if (value !== 'test_mode' && value !== 'live_mode') {
		throw new Error('DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode.');
	}
	return value;
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
