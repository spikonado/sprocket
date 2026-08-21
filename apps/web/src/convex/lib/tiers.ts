import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel, Doc } from '@convex/_generated/dataModel';
import {
	assertSupportedModelConfiguration,
	getModelDefinition,
	modelIds,
	serviceTierIds,
	type SupportedModelId,
	type SupportedReasoningEffort,
	type SupportedServiceTier
} from '@convex/lib/models';

export const subscriptionTierIds = ['free', 'pro', 'admin'] as const;
export type SubscriptionTier = (typeof subscriptionTierIds)[number];

export const tierLabels: Record<SubscriptionTier, string> = {
	free: 'Free',
	pro: 'Pro',
	admin: 'Admin'
};

export type TierLimits = {
	modelUsage: { weekly: number; monthly: number };
};

const freeLimits: TierLimits = {
	modelUsage: { weekly: 5_000, monthly: 15_000 }
};

const proLimits: TierLimits = {
	modelUsage: {
		weekly: freeLimits.modelUsage.weekly * 5,
		monthly: freeLimits.modelUsage.monthly * 5
	}
};

const adminQuota = 1_000_000_000;

export const tierLimits: Record<SubscriptionTier, TierLimits> = {
	free: freeLimits,
	pro: proLimits,
	admin: {
		modelUsage: { weekly: adminQuota, monthly: adminQuota }
	}
};

export const tierAllowedModels: Record<SubscriptionTier, readonly SupportedModelId[]> = {
	free: ['stealth/ox-alpha', 'deepseek-v4-pro-0813', 'deepseek-v4-flash-0731'],
	pro: modelIds,
	admin: modelIds
};

export const tierAllowedServiceTiers: Record<SubscriptionTier, readonly SupportedServiceTier[]> = {
	free: ['standard'],
	pro: serviceTierIds,
	admin: serviceTierIds
};

export const modelLockUpgradeMessage = 'Upgrade to a higher tier to unlock this model' as const;
export const serviceTierLockUpgradeMessage =
	'Upgrade to a higher tier to unlock this service tier' as const;

export function isModelAllowedForTier(tier: SubscriptionTier, modelId: SupportedModelId): boolean {
	return tierAllowedModels[tier].includes(modelId);
}

export function assertModelAllowedForTier(tier: SubscriptionTier, modelId: SupportedModelId): void {
	if (isModelAllowedForTier(tier, modelId)) return;
	throw new Error(
		`${getModelDefinition(modelId).label} is not available on the ${tierLabels[tier]} plan. Upgrade to a higher tier to unlock this model.`
	);
}

export function resolveModelForTier(
	tier: SubscriptionTier,
	modelId: SupportedModelId
): SupportedModelId {
	if (isModelAllowedForTier(tier, modelId)) return modelId;
	return tierAllowedModels[tier][0];
}

export function isServiceTierAllowedForTier(
	tier: SubscriptionTier,
	serviceTier: SupportedServiceTier
): boolean {
	return tierAllowedServiceTiers[tier].includes(serviceTier);
}

export function assertServiceTierAllowedForTier(
	tier: SubscriptionTier,
	serviceTier: SupportedServiceTier
): void {
	if (isServiceTierAllowedForTier(tier, serviceTier)) return;
	throw new Error(
		`The ${serviceTier} service tier is not available on the ${tierLabels[tier]} plan. Upgrade to a higher tier to unlock it.`
	);
}

export async function assertModelConfigurationAllowedForUser(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	userId: string,
	args: {
		modelId: SupportedModelId;
		reasoningEffort?: SupportedReasoningEffort;
		serviceTier: SupportedServiceTier;
	}
): Promise<SubscriptionTier> {
	assertSupportedModelConfiguration(args);
	const subscriptionTier = await getSubscriptionTier(ctx, userId);
	assertModelAllowedForTier(subscriptionTier, args.modelId);
	assertServiceTierAllowedForTier(subscriptionTier, args.serviceTier);
	return subscriptionTier;
}

/** Dodo product id per paid tier; 'free' and 'admin' never have one. */
export const tierProductIds: Partial<Record<SubscriptionTier, string>> = {};

export function tierForProductId(productId: string): SubscriptionTier | undefined {
	return subscriptionTierIds.find((tier) => tierProductIds[tier] === productId);
}

/** Active admin grants are manual and outrank every Dodo-driven row. */
function subscriptionRank(subscription: Doc<'subscriptions'>): number {
	return subscription.status === 'active' && subscription.tier === 'admin' ? 1 : 0;
}

function pickSubscription(rows: Doc<'subscriptions'>[]): Doc<'subscriptions'> | null {
	if (rows.length === 0) return null;
	return rows.reduce((best, row) => {
		const bestRank = subscriptionRank(best);
		const rowRank = subscriptionRank(row);
		if (rowRank !== bestRank) return rowRank > bestRank ? row : best;
		// Recency wins so a newer cancellation supersedes an older active row.
		if (row.eventAt !== best.eventAt) return row.eventAt > best.eventAt ? row : best;
		// Same event time (e.g. webhook retries): keep an active row over a lapsed one.
		const rowActive = row.status === 'active';
		const bestActive = best.status === 'active';
		if (rowActive !== bestActive) return rowActive ? row : best;
		return best;
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
		// No Dodo binding yet; empty-string sentinels keep the fields required.
		dodoSubscriptionId: '',
		dodoProductId: '',
		status: 'active',
		eventAt: 0
	});
	return 'free';
}
