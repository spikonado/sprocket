import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { posthog } from '@convex/lib/analytics';
import { billingWindow, type BillingWindowSubscription } from '@convex/lib/billingWindows';
import { ensureSubscription, resolveTierLimits, type SubscriptionTier } from '@convex/lib/tiers';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function usageRow(ctx: QueryCtx, userId: string, windowStart: number) {
	return await ctx.db
		.query('usage')
		.withIndex('by_userId_and_windowStart', (q) =>
			q.eq('userId', userId).eq('windowStart', windowStart)
		)
		.unique();
}

export async function readUsage(
	ctx: QueryCtx,
	userId: string,
	subscription: BillingWindowSubscription | null,
	now: number
): Promise<{ used: number; resetsAt: number }> {
	const window = billingWindow(subscription, now);

	return { used: (await usageRow(ctx, userId, window.start))?.used ?? 0, resetsAt: window.end };
}

/** Returns the usage recorded in the window before these units. */
export async function addUsage(
	ctx: MutationCtx,
	userId: string,
	windowStart: number,
	units: number
): Promise<number> {
	const row = await usageRow(ctx, userId, windowStart);

	if (row) {
		await ctx.db.patch('usage', row._id, { used: row.used + units });

		return row.used;
	}

	await ctx.db.insert('usage', { userId, windowStart, used: units });

	return 0;
}

export async function resetUsage(
	ctx: MutationCtx,
	userId: string,
	subscription: BillingWindowSubscription,
	now: number
): Promise<void> {
	const row = await usageRow(ctx, userId, billingWindow(subscription, now).start);

	if (row) await ctx.db.delete('usage', row._id);
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
	const { used, resetsAt } = await readUsage(ctx, userId, subscription, now);

	if (used < limit) return { tier, exhausted: false };

	return {
		tier,
		exhausted: true,
		message: `Usage limit reached. Try again in ${formatRetryAfter(resetsAt - now)}.`
	};
}

export async function chargeUsage(ctx: MutationCtx, userId: string, units: number): Promise<void> {
	if (units <= 0) return;
	const now = Date.now();
	const { tier, subscription } = await ensureSubscription(ctx, userId, now);
	const { modelUsage: limit } = await resolveTierLimits(ctx, tier);
	const usedBefore = await addUsage(ctx, userId, billingWindow(subscription, now).start, units);

	if (usedBefore < limit && usedBefore + units >= limit) {
		await posthog.capture(ctx, {
			distinctId: userId,
			event: 'quota_exhausted',
			properties: { tier }
		});
	}
}
