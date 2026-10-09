import {
	DAY,
	HOUR,
	MINUTE,
	RateLimiter,
	SECOND,
	WEEK,
	calculateRateLimit,
	type MutationCtx,
	type QueryCtx,
	type RateLimitConfig
} from '@convex-dev/rate-limiter';
import { components } from '@convex/_generated/api';
import type { DataModel } from '@convex/_generated/dataModel';
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
import { billingWindow, type BillingWindowSubscription } from '@convex/lib/billingWindows';

export { usageMeters, usagePeriods, type UsageMeterId, type UsagePeriod };

export const rateLimiter = new RateLimiter(components.rateLimiter, {});

// A single model call charges a small multiple of UNITS_PER_DOLLAR; anything
// above this is a caller bug or a replayed token, not real usage.
export const MAX_QUOTA_CHARGE_UNITS = 1_000_000_000_000;

const METER_CAPACITY = 4_000_000_000_000_000;

const STORAGE_PERIOD = 365 * DAY;

type MeterWindowSubscription = BillingWindowSubscription & {
	quotaGeneration?: number;
	// Legacy usage-generation key (an event timestamp) written before the
	// monotonic generation existed.
	quotaResetAt?: number;
};

// The window key's usage generation. Rows written by the current projection
// carry the monotonic counter; pre-migration rows fall back to the legacy
// timestamp key so their buckets stay consistent until backfilled.
function quotaGenerationOf(subscription: MeterWindowSubscription | null): number | undefined {
	return subscription?.quotaResetAt ?? subscription?.quotaGeneration;
}

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
	userId: string,
	period: UsagePeriod,
	subscription: MeterWindowSubscription | null,
	now: number
) {
	const { start, end } = billingWindow(period, subscription, now);

	return {
		key: windowKey(userId, period, start, quotaGenerationOf(subscription)),
		config: { kind: 'fixed window' as const, period: STORAGE_PERIOD, rate: METER_CAPACITY, start },
		start,
		end
	};
}

async function usedInWindow(
	ctx: QueryCtx,
	meterId: UsageMeterId,
	period: UsagePeriod,
	userId: string,
	limits: TierLimits,
	subscription: MeterWindowSubscription | null,
	now: number
) {
	const window = meterWindowConfig(userId, period, subscription, now);

	const stored = await rateLimiter.getValue(ctx, meterLimitName(meterId, period), {
		key: window.key,
		config: window.config
	});

	if (stored.ts !== 0) {
		return { used: Math.max(0, METER_CAPACITY - stored.value), window, migrated: true };
	}

	if (quotaGenerationOf(subscription) !== undefined) return { used: 0, window, migrated: true };

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
	ctx: MutationCtx,
	meterId: UsageMeterId,
	userId: string,
	limits: TierLimits,
	subscription: MeterWindowSubscription | null,
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

			return { period, end: window.end, blocked: used >= limit };
		})
	);

	const blocked = statuses.filter(({ blocked }) => blocked).sort((a, b) => b.end - a.end)[0];

	if (blocked) {
		return { period: blocked.period, retryAfter: Math.max(0, blocked.end - now) };
	}

	return undefined;
}

async function checkMeterLimits(
	ctx: MutationCtx,
	meterId: UsageMeterId,
	userId: string,
	limits: TierLimits,
	subscription: MeterWindowSubscription | null,
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
	const now = Date.now();
	const { tier, subscription } = await ensureSubscription(ctx, userId, now);
	const limits = await resolveTierLimits(ctx, tier);

	const blocked = await blockedMeterLimit(ctx, 'modelUsage', userId, limits, subscription, now);

	if (!blocked) return { tier, exhausted: false };

	return {
		tier,
		exhausted: true,
		message: `${meterLimitLabel('modelUsage', blocked.period)} reached. Try again in ${formatRetryAfter(blocked.retryAfter)}.`
	};
}

async function chargeMeterLimits(
	ctx: MutationCtx,
	meterId: UsageMeterId,
	userId: string,
	limits: TierLimits,
	subscription: MeterWindowSubscription | null,
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
	ctx: QueryCtx,
	meterId: UsageMeterId,
	period: UsagePeriod,
	userId: string,
	limits: TierLimits,
	subscription: MeterWindowSubscription | null,
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
	if (count <= 0) return;

	// A single model call charges a small multiple of UNITS_PER_DOLLAR; anything
	// above this is a caller bug or a replayed token, not real usage. Enforced
	// here so every charge path is covered, not just the gateway mutation.
	// Non-finite counts reach past the guard above (comparisons with NaN are
	// false), so they fail loudly here instead of going uncharged.
	if (!Number.isSafeInteger(count) || count > MAX_QUOTA_CHARGE_UNITS) {
		throw new ConvexError('Quota charge exceeds the per-call limit.');
	}

	const now = Date.now();
	const { tier, subscription } = await ensureSubscription(ctx, userId, now);
	await chargeMeterLimits(
		ctx,
		'modelUsage',
		userId,
		await resolveTierLimits(ctx, tier),
		subscription,
		now,
		count
	);
}

export const checkUsageLimits = internalMutation({
	args: { userId: v.string() },
	returns: v.null(),
	handler: async (ctx, { userId }) => {
		const now = Date.now();
		const { tier, subscription } = await ensureSubscription(ctx, userId, now);
		await checkMeterLimits(
			ctx,
			'modelUsage',
			userId,
			await resolveTierLimits(ctx, tier),
			subscription,
			now
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
