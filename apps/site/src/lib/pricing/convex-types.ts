import type { api } from '@convex/_generated/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

export type BillingInterval = FunctionArgs<typeof api.billing.checkout>['interval'];

export type CheckoutStatus = FunctionReturnType<typeof api.billing.getCheckoutStatus>;

export type MySubscription = FunctionReturnType<typeof api.billing.getMySubscription>;

export type PublicPricingCatalog = FunctionReturnType<typeof api.pricing.getPublicCatalog>;

export type DodoPrice = Pick<
	NonNullable<PublicPricingCatalog['plans'][number]['prices'][BillingInterval]>,
	'amountMinor' | 'currency'
>;
