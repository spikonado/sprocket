import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel } from '@convex/_generated/dataModel';

export const subscriptionTierIds = ['free', 'pro'] as const;
export type SubscriptionTier = (typeof subscriptionTierIds)[number];

export type TierLimits = {
	modelUsage: { weekly: number; monthly: number };
	urlScrape: { weekly: number; monthly: number };
	webSearch: { weekly: number; monthly: number };
};

const sharedLimits: TierLimits = {
	modelUsage: { weekly: 25_000_000, monthly: 60_000_000 },
	urlScrape: { weekly: 100, monthly: 280 },
	webSearch: { weekly: 25, monthly: 60 }
};

export const tierLimits: Record<SubscriptionTier, TierLimits> = {
	free: sharedLimits,
	pro: sharedLimits
};

/** Dodo product id per paid tier; 'free' never has one. */
export const tierProductIds: Partial<Record<SubscriptionTier, string>> = {};

export function tierForProductId(productId: string): SubscriptionTier | undefined {
	return subscriptionTierIds.find((tier) => tierProductIds[tier] === productId);
}

export async function getSubscriptionTier(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	userId: string
): Promise<SubscriptionTier> {
	const subscription = await ctx.db
		.query('subscriptions')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.unique();
	return subscription?.status === 'active' ? subscription.tier : 'free';
}
