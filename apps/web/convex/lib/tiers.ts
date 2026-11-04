import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel, Doc } from '@convex/_generated/dataModel';

/** Tier ids are operator-owned (see the `tiers` table); an opaque string, not a union. */
export type SubscriptionTier = string;

export const MODEL_USAGE_UNITS_PER_DOLLAR = 1_000_000_000;

export type TierLimits = { modelUsage: number };

export type CachedTier = {
	id: string;
	label: string;
	limits: TierLimits;
};

function rowToCachedTier(row: Doc<'tiers'>): CachedTier {
	return {
		id: row.tierId,
		label: row.label,
		limits: { modelUsage: row.monthly }
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

export async function resolveTierLimits(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<TierLimits> {
	const match = (await getCachedTier(ctx, tierId)) ?? (await getCachedTier(ctx, 'free'));

	if (!match) throw new Error('Subscription tiers are unavailable.');

	return match.limits;
}

export async function getTierLabel(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<string> {
	const tier = await getCachedTier(ctx, tierId);

	return tier?.label ?? tierId;
}

/**
 * Limits and label from one tiers-table read. Unknown tiers show their id as
 * the label (matching getTierLabel) while limits fall back to the free tier.
 */
export async function resolveTier(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	tierId: string
): Promise<{ limits: TierLimits; label: string }> {
	const match = await getCachedTier(ctx, tierId);
	const fallback = match ?? (await getCachedTier(ctx, 'free'));

	if (!fallback) throw new Error('Subscription tiers are unavailable.');

	return { limits: fallback.limits, label: match?.label ?? tierId };
}

function pickSubscription(rows: Doc<'subscriptions'>[]): Doc<'subscriptions'> | null {
	if (rows.length === 0) return null;
	const grants = rows.filter((row) => isOperatorGrant(row) && row.tier !== 'free');

	if (grants.length) rows = grants;

	return rows.reduce((best, row) => {
		if (row.eventAt !== best.eventAt) return row.eventAt > best.eventAt ? row : best;
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

/** Every subscription row for the account, unpicked; read-only callers only. */
export async function listSubscriptionDocs(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	userId: string
): Promise<Doc<'subscriptions'>[]> {
	return await listSubscriptions(ctx, userId);
}

/** Collapse duplicate projections, never distinct provider identities. */
export async function getSubscriptionDocExclusive(
	ctx: GenericMutationCtx<DataModel>,
	userId: string
): Promise<Doc<'subscriptions'> | null> {
	const rows = await listSubscriptions(ctx, userId);
	const keep = pickSubscription(rows);

	if (!keep) return null;

	if (rows.length === 1) return keep;

	for (const row of rows) {
		if (
			row._id === keep._id ||
			(row.dodoSubscriptionId && row.dodoSubscriptionId !== keep.dodoSubscriptionId)
		)
			continue;

		if (isOperatorGrant(row) && row.tier !== 'free' && keep.dodoSubscriptionId) continue;

		await ctx.db.delete('subscriptions', row._id);
	}

	return keep;
}

export const RENEWAL_GRACE_MS = 60 * 60 * 1_000;

export type AccessPhase = 'paid' | 'renewal_processing' | 'none';

/** Rows without a Dodo subscription are operator-managed and have no provider clock. */
export function isOperatorGrant(
	subscription: Pick<Doc<'subscriptions'>, 'dodoSubscriptionId'>
): boolean {
	return !subscription.dodoSubscriptionId;
}

export type AccessClock = Pick<
	Doc<'subscriptions'>,
	| 'status'
	| 'dodoSubscriptionId'
	| 'billingPeriodStart'
	| 'billingPeriodEnd'
	| 'cancelAtNextBillingDate'
>;

/** The phase the provider billing period gives at `now`, ignoring the materialized phase. */
export function accessPhaseAt(subscription: AccessClock, now: number): AccessPhase {
	if (subscription.status !== 'active') return 'none';

	if (isOperatorGrant(subscription)) return 'paid';

	const termEnd = subscription.billingPeriodEnd;

	if (termEnd === undefined || !Number.isFinite(termEnd)) return 'none';
	const termStart = subscription.billingPeriodStart;

	if (
		termStart !== undefined &&
		(!Number.isFinite(termStart) || termStart >= termEnd || now < termStart)
	)
		return 'none';

	if (now < termEnd) return 'paid';

	if (subscription.cancelAtNextBillingDate === true) return 'none';

	return now < termEnd + RENEWAL_GRACE_MS ? 'renewal_processing' : 'none';
}

type EnforcementFields = AccessClock & Pick<Doc<'subscriptions'>, 'accessPhase' | 'accessEndsAt'>;

/**
 * Phase for paths that know `now`. Re-checking the clock keeps a delayed
 * expiry scheduler from extending access, and a materialized 'none' still
 * ends access unless it only waits for the term to start.
 */
export function enforcementAccessPhase(
	subscription: EnforcementFields | null,
	now: number
): AccessPhase {
	if (!subscription) return 'none';

	const awaitingTermStart =
		subscription.billingPeriodStart !== undefined &&
		subscription.accessEndsAt === subscription.billingPeriodStart;

	if (!isOperatorGrant(subscription) && subscription.accessPhase === 'none' && !awaitingTermStart)
		return 'none';

	return accessPhaseAt(subscription, now);
}

export function enforcementTier(
	subscription: (EnforcementFields & Pick<Doc<'subscriptions'>, 'tier'>) | null,
	now: number
): SubscriptionTier {
	return subscription && enforcementAccessPhase(subscription, now) !== 'none'
		? subscription.tier
		: 'free';
}

type DisplayFields = Pick<Doc<'subscriptions'>, 'status' | 'dodoSubscriptionId' | 'accessPhase'>;

/** Phase for reactive queries: reads only materialized fields, never wall time. */
export function displayAccessPhase(subscription: DisplayFields | null): AccessPhase {
	if (!subscription || subscription.status !== 'active') return 'none';

	if (isOperatorGrant(subscription)) return 'paid';

	return subscription.accessPhase ?? 'none';
}

export function displayTier(
	subscription: (DisplayFields & Pick<Doc<'subscriptions'>, 'tier'>) | null
): SubscriptionTier {
	return subscription && displayAccessPhase(subscription) !== 'none' ? subscription.tier : 'free';
}

export async function ensureSubscription(
	ctx: GenericMutationCtx<DataModel>,
	userId: string,
	now: number = Date.now()
): Promise<{ tier: SubscriptionTier; subscription: Doc<'subscriptions'> }> {
	const existing = await getSubscriptionDocExclusive(ctx, userId);

	if (existing) return { tier: enforcementTier(existing, now), subscription: existing };
	// eventAt 0 so bootstrap rows never win ordering over operator edits.

	const id = await ctx.db.insert('subscriptions', {
		userId,
		tier: 'free',
		status: 'active',
		eventAt: 0,
		accessPhase: 'paid'
	});

	const subscription = await ctx.db.get('subscriptions', id);

	if (!subscription) throw new Error('Subscription bootstrap did not persist.');

	return { tier: 'free', subscription };
}
