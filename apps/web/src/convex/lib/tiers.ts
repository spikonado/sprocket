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
};

function rowToCachedTier(row: Doc<'tiers'>): CachedTier {
	return {
		id: row.tierId,
		label: row.label,
		limits: { modelUsage: { weekly: row.weekly, monthly: row.monthly } },
		unitsPerDollar: row.unitsPerDollar
	};
}

/**
 * Strict tier lookup. Duplicate tierId rows fail fast with a clear error
 * instead of metering against an arbitrary row.
 */
export async function getCachedTier(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<CachedTier | null> {
	const rows = await ctx.db
		.query('tiers')
		.withIndex('by_tierId', (query) => query.eq('tierId', tierId))
		.collect();
	if (rows.length > 1) throw new Error(`Duplicate tiers rows for tier "${tierId}".`);
	const row = rows[0];
	return row ? rowToCachedTier(row) : null;
}

/** Limits for a tier, falling back to the free tier when unknown. */
export async function resolveTierLimits(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<TierLimits> {
	const match = (await getCachedTier(ctx, tierId)) ?? (await getCachedTier(ctx, 'free'));
	if (!match) throw new Error('Subscription tiers are unavailable.');
	return match.limits;
}

/** Limits, label, and unit scale in two strict lookups. */
export async function resolveTierInfo(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<{ limits: TierLimits; label: string; unitsPerDollar: number }> {
	const match = (await getCachedTier(ctx, tierId)) ?? (await getCachedTier(ctx, 'free'));
	if (!match) throw new Error('Subscription tiers are unavailable.');
	return { limits: match.limits, label: match.label, unitsPerDollar: match.unitsPerDollar };
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
