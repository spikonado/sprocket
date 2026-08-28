import {
	DAY,
	HOUR,
	MINUTE,
	RateLimiter,
	SECOND,
	WEEK,
	calculateRateLimit,
	type RateLimitConfig,
	type RunMutationCtx,
	type RunQueryCtx
} from '@convex-dev/rate-limiter';
import { components } from '@convex/_generated/api';
import type { DataModel } from '@convex/_generated/dataModel';
import { internalMutation } from '@convex/_generated/server';
import { type GenericMutationCtx } from 'convex/server';
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
export const rateLimiter = new RateLimiter(components.rateLimiter, {});

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

async function blockedMeterLimit(
	ctx: RunMutationCtx,
	meterId: UsageMeterId,
	key: string,
	limits: TierLimits
): Promise<{ period: UsagePeriod; retryAfter: number } | undefined> {
	const statuses = await Promise.all(
		usagePeriods.map(async (period) => ({
			period,
			status: await rateLimiter.check(ctx, meterLimitName(meterId, period), {
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

async function chargeMeterLimits(
	ctx: RunMutationCtx,
	meterId: UsageMeterId,
	key: string,
	limits: TierLimits,
	count: number
): Promise<void> {
	for (const period of usagePeriods) {
		await rateLimiter.limit(ctx, meterLimitName(meterId, period), {
			key,
			config: meterLimitConfig(meterId, period, limits),
			count,
			reserve: true
		});
	}
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
	const stored = await rateLimiter.getValue(ctx, meterLimitName(meterId, period), {
		key: userId,
		config
	});
	// A fixed window starts on first use; ts === 0 means it never has.
	if (stored.ts === 0) return { used: 0, limit: config.rate, resetsAt: null };
	const current = calculateRateLimit({ value: stored.value, ts: stored.ts }, config, now);
	return {
		used: Math.max(0, config.rate - current.value),
		limit: config.rate,
		resetsAt: current.ts + config.period
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
