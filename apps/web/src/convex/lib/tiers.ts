import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel, Doc } from '@convex/_generated/dataModel';

export const subscriptionTierIds = ['free', 'pro', 'admin'] as const;
export type SubscriptionTier = (typeof subscriptionTierIds)[number];

export const tierLabels: Record<SubscriptionTier, string> = {
	free: 'Free',
	pro: 'Pro',
	admin: 'Admin'
};

export type TierLimits = {
	modelUsage: { weekly: number; monthly: number };
	webTools: { weekly: number; monthly: number };
};

const sharedLimits: TierLimits = {
	modelUsage: { weekly: 2_500, monthly: 7_500 },
	webTools: { weekly: 500, monthly: 1_500 }
};

const adminQuota = 1_000_000_000;

export const tierLimits: Record<SubscriptionTier, TierLimits> = {
	free: sharedLimits,
	pro: sharedLimits,
	admin: {
		modelUsage: { weekly: adminQuota, monthly: adminQuota },
		webTools: { weekly: adminQuota, monthly: adminQuota }
	}
};

/** Dodo product id per paid tier; 'free' and 'admin' never have one. */
export const tierProductIds: Partial<Record<SubscriptionTier, string>> = {};

export function tierForProductId(productId: string): SubscriptionTier | undefined {
	return subscriptionTierIds.find((tier) => tierProductIds[tier] === productId);
}

function subscriptionRank(subscription: Doc<'subscriptions'>): number {
	if (subscription.status === 'active' && subscription.tier === 'admin') return 3;
	if (subscription.status === 'active') return 2;
	return 1;
}

function pickSubscription(rows: Doc<'subscriptions'>[]): Doc<'subscriptions'> | null {
	if (rows.length === 0) return null;
	return rows.reduce((best, row) => {
		const bestRank = subscriptionRank(best);
		const rowRank = subscriptionRank(row);
		if (rowRank !== bestRank) return rowRank > bestRank ? row : best;
		return row.eventAt >= best.eventAt ? row : best;
	});
}

async function listSubscriptions(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	userId: string
): Promise<Doc<'subscriptions'>[]> {
	return await ctx.db
		.query('subscriptions')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.collect();
}

export async function getSubscriptionDoc(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	userId: string
): Promise<Doc<'subscriptions'> | null> {
	return pickSubscription(await listSubscriptions(ctx, userId));
}

/** Mutation-only: collapse concurrent ensure races onto one row. */
export async function getSubscriptionDocExclusive(
	ctx: GenericMutationCtx<DataModel>,
	userId: string
): Promise<Doc<'subscriptions'> | null> {
	const rows = await listSubscriptions(ctx, userId);
	const keep = pickSubscription(rows);
	if (!keep) return null;
	for (const row of rows) {
		if (row._id !== keep._id) await ctx.db.delete(row._id);
	}
	return keep;
}

export async function getSubscriptionTier(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	userId: string
): Promise<SubscriptionTier> {
	const subscription = await getSubscriptionDoc(ctx, userId);
	return subscription?.status === 'active' ? subscription.tier : 'free';
}

/** Insert a free/active row when missing; never overwrites an existing grant. */
export async function ensureSubscription(
	ctx: GenericMutationCtx<DataModel>,
	userId: string
): Promise<SubscriptionTier> {
	const existing = await getSubscriptionDocExclusive(ctx, userId);
	if (existing) return existing.status === 'active' ? existing.tier : 'free';
	// eventAt 0 so bootstrap rows never win ordering over Dodo webhooks.
	await ctx.db.insert('subscriptions', {
		userId,
		tier: 'free',
		status: 'active',
		eventAt: 0
	});
	return 'free';
}
