import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { posthog } from '@convex/lib/analytics';
import { billingWindow } from '@convex/lib/billingWindows';
import { legacyUsage } from '@convex/lib/legacyUsage';
import { ensureSubscription, resolveTierLimits, type SubscriptionTier } from '@convex/lib/tiers';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export async function readUsage(
	ctx: QueryCtx,
	userId: string,
	subscription: Doc<'subscriptions'> | null,
	now: number
) {
	const window = billingWindow(subscription, now);

	const row = await ctx.db
		.query('usage')
		.withIndex('by_userId_and_windowStart', (q) =>
			q.eq('userId', userId).eq('windowStart', window.start)
		)
		.unique();

	const used =
		row?.used ?? (await legacyUsage(ctx, userId, window.start, subscription?.quotaResetAt));

	return { window, row, used };
}

/** Clears every window, including a paid term that resumes after a hold. */
export async function resetUsage(ctx: MutationCtx, userId: string): Promise<void> {
	const rows = await ctx.db
		.query('usage')
		.withIndex('by_userId_and_windowStart', (q) => q.eq('userId', userId))
		.collect();

	for (const row of rows) await ctx.db.delete('usage', row._id);
}

function formatRetryAfter(milliseconds: number): string {
	let remaining = Math.max(SECOND, Math.ceil(milliseconds / SECOND) * SECOND);
	const parts: string[] = [];

	for (const [suffix, size] of [
		['d', DAY],
		['h', HOUR],
		['m', MINUTE]
	] as const) {
		const value = Math.floor(remaining / size);
		remaining %= size;

		if (value > 0) parts.push(`${value}${suffix}`);
	}

	const seconds = remaining / SECOND;

	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

	return parts.join(' ');
}

export async function gatewayQuotaStatus(
	ctx: MutationCtx,
	userId: string
): Promise<
	| { tier: SubscriptionTier; exhausted: false }
	| { tier: SubscriptionTier; exhausted: true; message: string }
> {
	const now = Date.now();
	const { tier, subscription } = await ensureSubscription(ctx, userId, now);
	const { modelUsage: limit } = await resolveTierLimits(ctx, tier);
	const { used, window } = await readUsage(ctx, userId, subscription, now);

	if (used < limit) return { tier, exhausted: false };

	return {
		tier,
		exhausted: true,
		message: `Usage limit reached. Try again in ${formatRetryAfter(window.end - now)}.`
	};
}

export async function chargeUsage(ctx: MutationCtx, userId: string, units: number): Promise<void> {
	if (units <= 0) return;
	const now = Date.now();
	const { tier, subscription } = await ensureSubscription(ctx, userId, now);
	const { modelUsage: limit } = await resolveTierLimits(ctx, tier);
	const { window, row, used } = await readUsage(ctx, userId, subscription, now);

	if (row) await ctx.db.patch('usage', row._id, { used: used + units });
	else await ctx.db.insert('usage', { userId, windowStart: window.start, used: used + units });

	if (used < limit && used + units >= limit) {
		await posthog.capture(ctx, {
			distinctId: userId,
			event: 'quota_exhausted',
			properties: { tier }
		});
	}
}
