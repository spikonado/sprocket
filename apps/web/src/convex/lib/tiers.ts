import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel, Doc } from '@convex/_generated/dataModel';

/** Tier ids are operator-owned (see the `tiers` table); an opaque string, not a union. */
export type SubscriptionTier = string;

export type TierLimits = {
	modelUsage: { weekly: number; monthly: number };
};

export type CachedTier = {
	id: string;
	label: string;
	limits: TierLimits;
	unitsPerDollar: number;
	updatedAt: number;
};

function rowToCachedTier(row: Doc<'tiers'>): CachedTier {
	return {
		id: row.tierId,
		label: row.label,
		limits: { modelUsage: { weekly: row.weekly, monthly: row.monthly } },
		unitsPerDollar: row.unitsPerDollar,
		updatedAt: row.updatedAt
	};
}

export async function listCachedTiers(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
): Promise<CachedTier[]> {
	const rows = await ctx.db.query('tiers').collect();
	// Operator edits can leave duplicate tierId rows; the latest edit wins so
	// every reader agrees on one definition.
	const latest = new Map<string, CachedTier>();
	for (const tier of rows.map(rowToCachedTier)) {
		if ((latest.get(tier.id)?.updatedAt ?? -1) <= tier.updatedAt) latest.set(tier.id, tier);
	}
	return [...latest.values()];
}

/** Prefer the requested tier, falling back to the free tier when unknown. */
function pickTier(tiers: CachedTier[], tierId: string): CachedTier | null {
	return (
		tiers.find((tier) => tier.id === tierId) ?? tiers.find((tier) => tier.id === 'free') ?? null
	);
}

export async function getCachedTier(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<CachedTier | null> {
	return (await listCachedTiers(ctx)).find((tier) => tier.id === tierId) ?? null;
}

/** Limits for a tier, falling back to the free tier when unknown. */
export async function resolveTierLimits(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<TierLimits> {
	const match = pickTier(await listCachedTiers(ctx), tierId);
	if (!match) throw new Error('Subscription tiers are unavailable.');
	return match.limits;
}

/** Limits and label in a single pass over the `tiers` table. */
export async function resolveTierInfo(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<{ limits: TierLimits; label: string }> {
	const match = pickTier(await listCachedTiers(ctx), tierId);
	if (!match) throw new Error('Subscription tiers are unavailable.');
	return { limits: match.limits, label: match.label };
}

export async function getTierLabel(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<string> {
	const tier = await getCachedTier(ctx, tierId);
	return tier?.label ?? tierId;
}

function pickSubscription(rows: Doc<'subscriptions'>[]): Doc<'subscriptions'> | null {
	if (rows.length === 0) return null;
	return rows.reduce((best, row) => {
		// Recency wins so a newer row supersedes an older one.
		if (row.eventAt !== best.eventAt) return row.eventAt > best.eventAt ? row : best;
		// Same event time (e.g. retried edits): keep an active row over a lapsed one.
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
		if (row._id !== keep._id) await ctx.db.delete('subscriptions', row._id);
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
	// eventAt 0 so bootstrap rows never win ordering over operator edits.
	await ctx.db.insert('subscriptions', {
		userId,
		tier: 'free',
		status: 'active',
		eventAt: 0
	});
	return 'free';
}
