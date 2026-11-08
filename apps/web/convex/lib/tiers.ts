import type { Doc } from '@convex/_generated/dataModel';
import type { QueryCtx } from '@convex/_generated/server';
import { getUserBySubject } from '@convex/lib/auth';
import type { BillingInterval } from '@convex/lib/dodoProducts';

/** Tier ids are operator-owned (see the `tiers` table); an opaque string, not a union. */
export type SubscriptionTier = string;

export const MODEL_USAGE_UNITS_PER_DOLLAR = 1_000_000_000;

export const RENEWAL_GRACE_MS = 60 * 60 * 1_000;

type PaidSubscription = Doc<'subscriptions'> & {
	dodoProductId: string;
	billingPeriodStart: number;
	billingPeriodEnd: number;
};

export type PaidTerm = Pick<PaidSubscription, 'billingPeriodStart' | 'billingPeriodEnd'> & {
	interval: BillingInterval;
};

export type Plan = {
	tier: SubscriptionTier;
	label: string;
	limits: { modelUsage: number };
	/** The Dodo subscription that grants the tier; null for free and granted tiers. */
	subscription: (PaidSubscription & PaidTerm) | null;
	legacyQuotaResetAt: number | undefined;
};

/** Strict lookup: duplicate tierId rows fail instead of metering against an arbitrary row. */
export async function getTierRow(ctx: QueryCtx, tierId: string): Promise<Doc<'tiers'> | null> {
	const rows = await ctx.db
		.query('tiers')
		.withIndex('by_tierId', (query) => query.eq('tierId', tierId))
		.take(2);

	if (rows.length > 1) throw new Error(`Duplicate tiers rows for tier "${tierId}".`);

	return rows[0] ?? null;
}

async function tiersSellingProduct(ctx: QueryCtx, productId: string) {
	const [monthly, annual] = await Promise.all([
		ctx.db
			.query('tiers')
			.withIndex('by_monthlyProductId', (query) => query.eq('monthlyProductId', productId))
			.take(2),
		ctx.db
			.query('tiers')
			.withIndex('by_annualProductId', (query) => query.eq('annualProductId', productId))
			.take(2)
	]);

	if (monthly.length + annual.length > 1) {
		throw new Error(`Dodo product "${productId}" is assigned more than once.`);
	}

	return { monthly: monthly[0], annual: annual[0] };
}

export async function assertSingleTierSells(ctx: QueryCtx, productId: string): Promise<void> {
	await tiersSellingProduct(ctx, productId);
}

export async function tierForProduct(
	ctx: QueryCtx,
	productId: string
): Promise<{ row: Doc<'tiers'>; interval: BillingInterval } | null> {
	const { monthly, annual } = await tiersSellingProduct(ctx, productId);

	if (monthly) return { row: monthly, interval: 'monthly' };

	if (annual) return { row: annual, interval: 'annual' };

	return null;
}

function hasAccess(
	subscription: Doc<'subscriptions'>,
	now: number
): subscription is PaidSubscription {
	const { status, dodoProductId, billingPeriodStart, billingPeriodEnd } = subscription;

	if (status !== 'active' || !dodoProductId) return false;

	if (billingPeriodStart === undefined || billingPeriodEnd === undefined) return false;
	const grace = subscription.cancelAtNextBillingDate ? 0 : RENEWAL_GRACE_MS;

	return billingPeriodStart <= now && now < billingPeriodEnd + grace;
}

/** Unknown tier ids keep their id as the label and meter against the free tier. */
async function planForTier(
	ctx: QueryCtx,
	tierId: string,
	known?: Doc<'tiers'>
): Promise<Pick<Plan, 'tier' | 'label' | 'limits'>> {
	const row = known ?? (await getTierRow(ctx, tierId));
	const limitsRow = row ?? (await getTierRow(ctx, 'free'));

	if (!limitsRow) throw new Error('Subscription tiers are unavailable.');

	return { tier: tierId, label: row?.label ?? tierId, limits: { modelUsage: limitsRow.monthly } };
}

/** The granted tier, else the highest-allowance Dodo subscription with access, else free. */
export async function resolvePlan(ctx: QueryCtx, userId: string, now: number): Promise<Plan> {
	const user = await getUserBySubject(ctx.db, userId);

	if (user?.grantedTier) {
		return {
			...(await planForTier(ctx, user.grantedTier)),
			subscription: null,
			legacyQuotaResetAt: undefined
		};
	}

	const rows = await ctx.db
		.query('subscriptions')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.collect();

	let best: { row: Doc<'tiers'>; subscription: PaidSubscription & PaidTerm } | null = null;

	for (const subscription of rows) {
		if (!hasAccess(subscription, now)) continue;
		const match = await tierForProduct(ctx, subscription.dodoProductId);

		if (!match || (best && best.row.monthly >= match.row.monthly)) continue;

		best = { row: match.row, subscription: { ...subscription, interval: match.interval } };
	}

	if (best) {
		return {
			...(await planForTier(ctx, best.row.tierId, best.row)),
			subscription: best.subscription,
			legacyQuotaResetAt: best.subscription.quotaResetAt
		};
	}

	const legacyResets = rows.flatMap((row) =>
		row.quotaResetAt === undefined ? [] : [row.quotaResetAt]
	);

	return {
		...(await planForTier(ctx, 'free')),
		subscription: null,
		legacyQuotaResetAt: legacyResets.length ? Math.max(...legacyResets) : undefined
	};
}
