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

export function readDodoEnvironment(env: { DODO_PAYMENTS_ENVIRONMENT?: string }): DodoEnvironment {
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
	return classifyBillingInterval(paymentFrequencyCount, paymentFrequencyInterval) === interval;
}

export function classifyBillingInterval(
	paymentFrequencyCount: number,
	paymentFrequencyInterval: string
): BillingInterval | null {
	if (paymentFrequencyInterval === 'Month' && paymentFrequencyCount === 1) return 'monthly';

	if (
		(paymentFrequencyInterval === 'Year' && paymentFrequencyCount === 1) ||
		(paymentFrequencyInterval === 'Month' && paymentFrequencyCount === 12)
	)
		return 'annual';

	return null;
}
