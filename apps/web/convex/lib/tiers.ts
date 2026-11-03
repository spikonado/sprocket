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
	const grants = rows.filter((row) => !row.dodoSubscriptionId && row.tier !== 'free');

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

		if (!row.dodoSubscriptionId && row.tier !== 'free' && keep.dodoSubscriptionId) continue;

		await ctx.db.delete('subscriptions', row._id);
	}

	return keep;
}

/** Rows without a Dodo ID are operator grants and skip the billing-period clock check. */
type SubscriptionActivity = Pick<
	Doc<'subscriptions'>,
	'status' | 'dodoSubscriptionId' | 'billingPeriodEnd' | 'accessPhase' | 'accessEndsAt'
>;

/**
 * True while paid access continues: the confirmed paid term, or the bounded
 * renewal-processing grace after it. Confirmed failure/cancellation/expiry
 * and grace exhaustion are inactive.
 *
 * Pure-function variant of the materialized scheduler state so callers that
 * already know "now" (enforcement paths, tests, fake-time fixtures) get the
 * same answer the materialized `accessPhase`/`accessEndsAt` fields converge
 * to. Reactive display queries should prefer the materialized fields.
 */
export function subscriptionIsActive<T extends SubscriptionActivity>(
	subscription: T | null,
	now: number
): subscription is T {
	return subscriptionAccessPhase(subscription, now) !== 'none';
}

/**
 * Tier for enforcement paths that know "now" (mutations, gateway auth,
 * fake-time fixtures): re-checks the wall-clock deadline so a delayed
 * scheduler cannot extend access.
 */
export function subscriptionTier(
	subscription: Doc<'subscriptions'> | null,
	now: number
): SubscriptionTier {
	return subscriptionIsActive(subscription, now) ? subscription.tier : 'free';
}

/**
 * Display variant of the paid-access phase for reactive queries: reads only
 * the materialized fields (never wall time) so the query converges from
 * document changes alone. The deadline stays in `accessEndsAt` for display.
 */
export function subscriptionMaterializedPhase(
	subscription: Pick<
		Doc<'subscriptions'>,
		'status' | 'dodoSubscriptionId' | 'billingPeriodEnd' | 'accessPhase'
	> | null
): AccessPhase {
	if (!subscription || subscription.status !== 'active') return 'none';

	if (!subscription.dodoSubscriptionId) return 'paid';

	if (subscription.billingPeriodEnd === undefined) return 'none';

	return subscription.accessPhase ?? 'none';
}

/**
 * Tier for reactive display queries: reads only the materialized access
 * fields the expiry scheduler maintains, so the result converges without the
 * query reading wall time.
 */
export function subscriptionMaterializedTier(
	subscription: Doc<'subscriptions'> | null
): SubscriptionTier {
	return subscriptionMaterializedPhase(subscription) === 'none'
		? 'free'
		: (subscription?.tier ?? 'free');
}

export const RENEWAL_GRACE_MS = 60 * 60 * 1_000;

export type AccessPhase = 'paid' | 'renewal_processing' | 'none';

type AccessFields = Pick<
	Doc<'subscriptions'>,
	| 'status'
	| 'dodoSubscriptionId'
	| 'billingPeriodStart'
	| 'billingPeriodEnd'
	| 'accessPhase'
	| 'accessEndsAt'
	| 'cancelAtNextBillingDate'
>;

export function subscriptionAccessPhase(
	subscription: AccessFields | null,
	now: number
): AccessPhase {
	if (!subscription || subscription.status !== 'active') return 'none';

	// Operator grants have no provider clock.
	if (!subscription.dodoSubscriptionId) return 'paid';

	if (!Number.isFinite(subscription.billingPeriodEnd)) return 'none';
	const termEnd = subscription.billingPeriodEnd!;
	const termStart = subscription.billingPeriodStart;

	if (
		termStart !== undefined &&
		(!Number.isFinite(termStart) || termStart >= termEnd || now < termStart)
	)
		return 'none';

	if (subscription.accessPhase === 'none' && !hasPendingTermStart(subscription)) return 'none';

	if (now < termEnd) return 'paid';

	if (subscription.cancelAtNextBillingDate === true) return 'none';

	const graceEnd = termEnd + RENEWAL_GRACE_MS;

	return now < graceEnd ? 'renewal_processing' : 'none';
}

function hasPendingTermStart(subscription: AccessFields): boolean {
	return (
		subscription.billingPeriodStart !== undefined &&
		subscription.accessEndsAt === subscription.billingPeriodStart
	);
}

export function subscriptionAccessDeadline(subscription: AccessFields | null): number | undefined {
	if (!subscription) return undefined;

	if (subscription.status !== 'active') return subscription.accessEndsAt ?? 0;

	if (!subscription.dodoSubscriptionId) return undefined;

	if (subscription.billingPeriodEnd === undefined) return undefined;

	if (subscription.accessPhase === 'none' && !hasPendingTermStart(subscription))
		return subscription.accessEndsAt ?? 0;

	if (subscription.cancelAtNextBillingDate === true) return subscription.billingPeriodEnd;

	return subscription.billingPeriodEnd + RENEWAL_GRACE_MS;
}

export async function ensureSubscription(
	ctx: GenericMutationCtx<DataModel>,
	userId: string,
	now: number = Date.now()
): Promise<{ tier: SubscriptionTier; subscription: Doc<'subscriptions'> }> {
	const existing = await getSubscriptionDocExclusive(ctx, userId);

	if (existing) return { tier: subscriptionTier(existing, now), subscription: existing };
	// eventAt 0 so bootstrap rows never win ordering over operator edits.

	const id = await ctx.db.insert('subscriptions', {
		userId,
		tier: 'free',
		status: 'active',
		eventAt: 0
	});

	const subscription = await ctx.db.get('subscriptions', id);

	if (!subscription) throw new Error('Subscription bootstrap did not persist.');

	return { tier: 'free', subscription };
}
