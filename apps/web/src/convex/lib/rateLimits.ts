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
import type { DataModel, Doc } from '@convex/_generated/dataModel';
import { internalMutation } from '@convex/_generated/server';
import { type GenericMutationCtx } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import {
	ensureSubscription,
	resolveTierLimits,
	type SubscriptionTier,
	type TierLimits
} from '@convex/lib/tiers';
import {
	usageMeters,
	usagePeriods,
	type UsageMeterId,
	type UsagePeriod
} from '@convex/lib/usageMeters';
import { billingWindow } from '@convex/lib/billingWindows';
import { getSubscriptionDoc } from '@convex/lib/tiers';

export { usageMeters, usagePeriods, type UsageMeterId, type UsagePeriod };

export const rateLimiter = new RateLimiter(components.rateLimiter, {});
const METER_CAPACITY = 4_000_000_000_000_000;
const STORAGE_PERIOD = 365 * DAY;

function meterLimitName(meterId: UsageMeterId, period: UsagePeriod): string {
	return `${meterId}${period === 'weekly' ? 'Weekly' : 'Monthly'}`;
}

function meterLimitConfig(
	meterId: UsageMeterId,
	period: UsagePeriod,
	limits: TierLimits,
	duration: number
): RateLimitConfig {
	return { kind: 'fixed window', period: duration, rate: limits[meterId][period] };
}

function windowKey(userId: string, period: UsagePeriod, start: number, resetAt?: number): string {
	return `${userId}:${period}:${start}:${resetAt ?? 0}`;
}

function meterWindowConfig(
	meterId: UsageMeterId,
	period: UsagePeriod,
	userId: string,
	limits: TierLimits,
	subscription: Doc<'subscriptions'> | null,
	now: number
) {
	const { start, end } = billingWindow(period, subscription, now);
	return {
		key: windowKey(userId, period, start, subscription?.quotaResetAt),
		config: { kind: 'fixed window' as const, period: STORAGE_PERIOD, rate: METER_CAPACITY, start },
		start,
		end
	};
}

async function usedInWindow(
	ctx: RunQueryCtx,
	meterId: UsageMeterId,
	period: UsagePeriod,
	userId: string,
	limits: TierLimits,
	subscription: Doc<'subscriptions'> | null,
	now: number
) {
	const window = meterWindowConfig(meterId, period, userId, limits, subscription, now);
	const stored = await rateLimiter.getValue(ctx, meterLimitName(meterId, period), {
		key: window.key,
		config: window.config
	});
	if (stored.ts !== 0) {
		return { used: Math.max(0, METER_CAPACITY - stored.value), window, migrated: true };
	}
	if (subscription?.quotaResetAt !== undefined) return { used: 0, window, migrated: true };
	const oldConfig = meterLimitConfig(
		meterId,
		period,
		limits,
		period === 'weekly' ? WEEK : 30 * DAY
	);
	const old = await rateLimiter.getValue(ctx, meterLimitName(meterId, period), {
		key: userId,
		config: oldConfig
	});
	if (old.ts === 0) return { used: 0, window, migrated: true };
	const current = calculateRateLimit({ value: old.value, ts: old.ts }, oldConfig, now);
	return {
		used:
			current.ts >= window.start && current.ts < window.end
				? Math.max(0, oldConfig.rate - current.value)
				: 0,
		window,
		migrated: false
	};
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
	userId: string,
	limits: TierLimits,
	subscription: Doc<'subscriptions'> | null,
	now: number
): Promise<{ period: UsagePeriod; retryAfter: number } | undefined> {
	const statuses = await Promise.all(
		usagePeriods.map(async (period) => {
			const { window, used } = await usedInWindow(
				ctx,
				meterId,
				period,
				userId,
				limits,
				subscription,
				now
			);
			const limit = limits[meterId][period];
			return { period, end: window.end, blocked: limit > 0 && used >= limit };
		})
	);
	const blocked = statuses.filter(({ blocked }) => blocked).sort((a, b) => b.end - a.end)[0];
	if (blocked) {
		return { period: blocked.period, retryAfter: Math.max(0, blocked.end - now) };
	}
	return undefined;
}

async function checkMeterLimits(
	ctx: RunMutationCtx,
	meterId: UsageMeterId,
	userId: string,
	limits: TierLimits,
	subscription: Doc<'subscriptions'> | null,
	now: number
): Promise<void> {
	const blocked = await blockedMeterLimit(ctx, meterId, userId, limits, subscription, now);
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
	const limits = await resolveTierLimits(ctx, tier);
	const blocked = await blockedMeterLimit(
		ctx,
		'modelUsage',
		userId,
		limits,
		await getSubscriptionDoc(ctx, userId),
		Date.now()
	);
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
	userId: string,
	limits: TierLimits,
	subscription: Doc<'subscriptions'> | null,
	now: number,
	count: number
): Promise<void> {
	for (const period of usagePeriods) {
		const { window, used, migrated } = await usedInWindow(
			ctx,
			meterId,
			period,
			userId,
			limits,
			subscription,
			now
		);
		await rateLimiter.limit(ctx, meterLimitName(meterId, period), {
			key: window.key,
			config: window.config,
			count: count + (migrated ? 0 : used),
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
	subscription: Doc<'subscriptions'> | null,
	now: number = Date.now()
): Promise<{ used: number; limit: number; resetsAt: number | null }> {
	const { used, window } = await usedInWindow(
		ctx,
		meterId,
		period,
		userId,
		limits,
		subscription,
		now
	);
	return {
		used,
		limit: limits[meterId][period],
		resetsAt: window.end
	};
}

export async function applyGatewayUsageCharge(
	ctx: GenericMutationCtx<DataModel>,
	userId: string,
	count: number
): Promise<void> {
	if (!Number.isFinite(count) || count <= 0) return;
	const tier = await ensureSubscription(ctx, userId);
	await chargeMeterLimits(
		ctx,
		'modelUsage',
		userId,
		await resolveTierLimits(ctx, tier),
		await getSubscriptionDoc(ctx, userId),
		Date.now(),
		count
	);
}

export const checkUsageLimits = internalMutation({
	args: { userId: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId }) => {
		const tier = await ensureSubscription(ctx, userId);
		await checkMeterLimits(
			ctx,
			'modelUsage',
			userId,
			await resolveTierLimits(ctx, tier),
			await getSubscriptionDoc(ctx, userId),
			Date.now()
		);
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

export const cleanupUsageWindows = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await ctx.runMutation(components.rateLimiter.lib.clearAll, {
			before: Date.now() - 62 * DAY
		});
		return null;
	}
});
