import {
	DAY,
	HOUR,
	MINUTE,
	SECOND,
	WEEK,
	calculateRateLimit,
	type RateLimitConfig,
	type RunMutationCtx,
	type RunQueryCtx
} from '@convex-dev/rate-limiter';
import { components, internal } from '@convex/_generated/api';
import type { DataModel } from '@convex/_generated/dataModel';
import { internalMutation } from '@convex/_generated/server';
import type { GenericMutationCtx } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import {
	ensureSubscription,
	tierLimits,
	type SubscriptionTier,
	type TierLimits
} from '@convex/lib/tiers';
import {
	usageMeters,
	usagePeriods,
	type UsageMeterId,
	type UsagePeriod
} from '@convex/lib/usageMeters';

export { usageMeters, usagePeriods, type UsageMeterId, type UsagePeriod };

const MONTH = 30 * DAY;

const periodDurations = { weekly: WEEK, monthly: MONTH } as const satisfies Record<
	UsagePeriod,
	number
>;

function meterLimitName(meterId: UsageMeterId, period: UsagePeriod): string {
	return `${meterId}${period === 'weekly' ? 'Weekly' : 'Monthly'}`;
}

function meterLimitConfig(
	meterId: UsageMeterId,
	period: UsagePeriod,
	limits: TierLimits
): RateLimitConfig {
	return { kind: 'fixed window', period: periodDurations[period], rate: limits[meterId][period] };
}

function meterLimitLabel(meterId: UsageMeterId, period: UsagePeriod): string {
	const meter = usageMeters.find((candidate) => candidate.id === meterId);
	if (!meter) throw new Error(`Unknown usage meter: ${meterId}`);
	return `${period === 'weekly' ? 'Weekly' : 'Monthly'} ${meter.noun} limit`;
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

/** A meter window read straight from the rate-limiter component. */
type MeterWindow = {
	value: number;
	ts: number;
	shard: number;
	config: RateLimitConfig;
};

/**
 * Writes always go to the canonical tokenIdentifier; rows charged before the
 * migration live under the legacy subject, so readers fold both into one
 * window. Without the legacy read a pre-migration overage would silently
 * become a fresh free window.
 */
async function readMeterWindow(
	ctx: RunQueryCtx,
	userId: string,
	name: string,
	config: RateLimitConfig
): Promise<MeterWindow> {
	const subject = await ctx.runQuery(internal.lib.auth.storedOwnerSubject, { userId });
	const canonical = await ctx.runQuery(components.rateLimiter.lib.getValue, {
		name,
		key: userId,
		config
	});
	const canonicalWindow: MeterWindow = {
		value: canonical.value,
		ts: canonical.ts,
		shard: canonical.shard,
		config
	};
	if (!subject || subject === userId) return canonicalWindow;
	const legacy = await ctx.runQuery(components.rateLimiter.lib.getValue, {
		name,
		key: subject,
		config
	});
	return largestMeterWindow(canonicalWindow, {
		value: legacy.value,
		ts: legacy.ts,
		shard: legacy.shard,
		config
	});
}

/** The original whose window reports more usage (or the only one started). */
function largestMeterWindow(left: MeterWindow, right: MeterWindow): MeterWindow {
	if (left.ts === 0) return right;
	if (right.ts === 0) return left;
	// Fixed-window shards keep usage as (rate - value); older windows have
	// decayed further, so the larger user-visible used amount is the tighter
	// bound for both blocking and display.
	const leftUsed = Math.max(0, left.config.rate - left.value);
	const rightUsed = Math.max(0, right.config.rate - right.value);
	// Shard zero holds the full window; nonzero shards are partial chunks.
	if (left.shard === 0 && right.shard !== 0) return left;
	if (right.shard === 0 && left.shard !== 0) return right;
	return leftUsed >= rightUsed ? left : right;
}

async function blockedForKey(
	ctx: RunQueryCtx,
	meterId: UsageMeterId,
	key: string,
	limits: TierLimits
): Promise<{ period: UsagePeriod; retryAfter: number } | undefined> {
	const statuses = await Promise.all(
		usagePeriods.map(async (period) => ({
			period,
			status: await ctx.runQuery(components.rateLimiter.lib.checkRateLimit, {
				name: meterLimitName(meterId, period),
				key,
				config: meterLimitConfig(meterId, period, limits)
			})
		}))
	);
	const blocked = statuses
		.filter(({ status }) => !status.ok)
		.sort((a, b) => (b.status.retryAfter ?? 0) - (a.status.retryAfter ?? 0))[0];
	if (blocked && !blocked.status.ok) {
		return { period: blocked.period, retryAfter: blocked.status.retryAfter ?? 0 };
	}
	return undefined;
}

async function blockedMeterLimit(
	ctx: RunMutationCtx,
	meterId: UsageMeterId,
	key: string,
	limits: TierLimits
): Promise<{ period: UsagePeriod; retryAfter: number } | undefined> {
	const canonical = await blockedForKey(ctx, meterId, key, limits);
	const subject = await ctx.runQuery(internal.lib.auth.storedOwnerSubject, { userId: key });
	if (!subject || subject === key) return canonical;
	const legacy = await blockedForKey(ctx, meterId, subject, limits);
	if (!canonical) return legacy;
	if (!legacy) return canonical;
	return legacy.retryAfter > canonical.retryAfter ? legacy : canonical;
}

async function checkMeterLimits(
	ctx: RunMutationCtx,
	meterId: UsageMeterId,
	key: string,
	limits: TierLimits
): Promise<void> {
	const blocked = await blockedMeterLimit(ctx, meterId, key, limits);
	if (!blocked) return;
	// A ConvexError keeps its message through production error masking, and
	// the executor only retries masked server failures.
	throw new ConvexError(
		`${meterLimitLabel(meterId, blocked.period)} reached. Try again in ${formatRetryAfter(blocked.retryAfter)}.`
	);
}

async function chargeOwnerKey(
	ctx: RunQueryCtx,
	userId: string,
	meterId: UsageMeterId,
	limits: TierLimits
): Promise<string> {
	const subject = await ctx.runQuery(internal.lib.auth.storedOwnerSubject, { userId });
	if (!subject || subject === userId) return userId;
	const config = meterLimitConfig(meterId, 'weekly', limits);
	const name = meterLimitName(meterId, 'weekly');
	const canonical = await ctx.runQuery(components.rateLimiter.lib.getValue, {
		name,
		key: userId,
		config
	});
	const legacy = await ctx.runQuery(components.rateLimiter.lib.getValue, {
		name,
		key: subject,
		config
	});
	if (legacy.ts === 0) return userId;
	if (canonical.ts === 0) return subject;
	const left: MeterWindow = {
		value: canonical.value,
		ts: canonical.ts,
		shard: canonical.shard,
		config
	};
	const right: MeterWindow = {
		value: legacy.value,
		ts: legacy.ts,
		shard: legacy.shard,
		config
	};
	return largestMeterWindow(left, right) === left ? userId : subject;
}

async function chargeMeterLimits(
	ctx: RunMutationCtx,
	meterId: UsageMeterId,
	key: string,
	limits: TierLimits,
	count: number
): Promise<void> {
	const chargeKey = await chargeOwnerKey(ctx, key, meterId, limits);
	for (const period of usagePeriods) {
		await ctx.runMutation(components.rateLimiter.lib.rateLimit, {
			name: meterLimitName(meterId, period),
			key: chargeKey,
			config: meterLimitConfig(meterId, period, limits),
			count,
			reserve: true
		});
	}
}

export async function gatewayQuotaStatus(
	ctx: GenericMutationCtx<DataModel>,
	userId: string
): Promise<{ tier: SubscriptionTier; exhausted: boolean; message?: string }> {
	const tier = await ensureSubscription(ctx, userId);
	if (tier === 'admin') return { tier, exhausted: false };
	const blocked = await blockedMeterLimit(ctx, 'modelUsage', userId, tierLimits[tier]);
	if (!blocked) return { tier, exhausted: false };
	return {
		tier,
		exhausted: true,
		message: `${meterLimitLabel('modelUsage', blocked.period)} reached. Try again in ${formatRetryAfter(blocked.retryAfter)}.`
	};
}

export async function getMeterWindow(
	ctx: RunQueryCtx,
	meterId: UsageMeterId,
	period: UsagePeriod,
	userId: string,
	limits: TierLimits,
	now: number = Date.now()
): Promise<{ used: number; limit: number; resetsAt: number | null }> {
	const config = meterLimitConfig(meterId, period, limits);
	const stored = await readMeterWindow(ctx, userId, meterLimitName(meterId, period), config);
	// A fixed window starts on first use; ts === 0 means it never has.
	if (stored.ts === 0) return { used: 0, limit: config.rate, resetsAt: null };
	const current = calculateRateLimit({ value: stored.value, ts: stored.ts }, stored.config, now);
	return {
		used: Math.max(0, stored.config.rate - current.value),
		limit: config.rate,
		resetsAt: current.ts + stored.config.period
	};
}

export async function applyGatewayUsageCharge(
	ctx: GenericMutationCtx<DataModel>,
	userId: string,
	count: number
): Promise<void> {
	if (count <= 0) return;
	const tier = await ensureSubscription(ctx, userId);
	if (tier === 'admin') return;
	await chargeMeterLimits(ctx, 'modelUsage', userId, tierLimits[tier], count);
}

export const checkUsageLimits = internalMutation({
	args: { userId: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId }) => {
		const tier = await ensureSubscription(ctx, userId);
		if (tier === 'admin') return null;
		await checkMeterLimits(ctx, 'modelUsage', userId, tierLimits[tier]);
		return null;
	}
});

export const chargeUsageUnits = internalMutation({
	args: {
		userId: v.string(),
		count: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await applyGatewayUsageCharge(ctx, args.userId, args.count);
		return null;
	}
});
