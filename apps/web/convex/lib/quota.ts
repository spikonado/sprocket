import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { posthog } from '@convex/lib/analytics';
import { billingWindow } from '@convex/lib/billingWindows';
import { drawCredits, remainingCredits, spendableGrants } from '@convex/lib/credits';
import { legacyUsage } from '@convex/lib/legacyUsage';
import { resolvePlan, type Plan, type SubscriptionTier } from '@convex/lib/tiers';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export async function readUsage(ctx: QueryCtx, userId: string, plan: Plan, now: number) {
	const window = billingWindow(plan.subscription, now);

	const row = await ctx.db
		.query('usage')
		.withIndex('by_userId_and_windowStart', (q) =>
			q.eq('userId', userId).eq('windowStart', window.start)
		)
		.unique();

	const used = row?.used ?? (await legacyUsage(ctx, userId, window.start, plan.legacyQuotaResetAt));

	return { window, row, used };
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
	const plan = await resolvePlan(ctx, userId, now);
	const { tier } = plan;
	const { used, window } = await readUsage(ctx, userId, plan, now);

	if (used < plan.limits.modelUsage || (await spendableGrants(ctx, userId, now)).length > 0) {
		return { tier, exhausted: false };
	}

	return {
		tier,
		exhausted: true,
		message: `Usage limit reached. Try again in ${formatRetryAfter(window.end - now)}.`
	};
}

/** Draws the allowance window first, then credit grants; what grants can't cover overdraws the window. */
export async function chargeUsage(ctx: MutationCtx, userId: string, units: number): Promise<void> {
	if (units <= 0) return;
	const now = Date.now();
	const plan = await resolvePlan(ctx, userId, now);
	const limit = plan.limits.modelUsage;
	const { window, row, used } = await readUsage(ctx, userId, plan, now);
	const grants = await spendableGrants(ctx, userId, now);
	const credits = remainingCredits(grants);
	const fromAllowance = Math.min(units, Math.max(0, limit - used));
	const fromCredits = Math.min(units - fromAllowance, credits);
	const windowUsed = used + units - fromCredits;

	await drawCredits(ctx, grants, fromCredits);

	if (windowUsed !== used) {
		if (row) await ctx.db.patch('usage', row._id, { used: windowUsed });
		else await ctx.db.insert('usage', { userId, windowStart: window.start, used: windowUsed });
	}

	const wasExhausted = used >= limit && credits === 0;
	const isExhausted = windowUsed >= limit && fromCredits === credits;

	if (!wasExhausted && isExhausted) {
		await posthog.capture(ctx, {
			distinctId: userId,
			event: 'quota_exhausted',
			properties: { tier: plan.tier }
		});
	}
}
