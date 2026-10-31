import {
	DAY,
	HOUR,
	MINUTE,
	RateLimiter,
	SECOND,
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
import { usageMeters, type UsageMeterId } from '@convex/lib/usageMeters';
import { billingWindow, type BillingWindowSubscription } from '@convex/lib/billingWindows';
import { posthog } from '@convex/lib/analytics';

export { usageMeters, type UsageMeterId };

export const rateLimiter = new RateLimiter(components.rateLimiter, {});

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

// The stored limit names and window keys keep their "monthly" component so
// existing buckets stay readable after weekly limits were removed.
function meterLimitName(meterId: UsageMeterId): string {
	return `${meterId}Monthly`;
}

function windowKey(userId: string, start: number, resetAt?: number): string {
	return `${userId}:monthly:${start}:${resetAt ?? 0}`;
}

function meterWindowConfig(
	userId: string,
	subscription: MeterWindowSubscription | null,
	now: number
) {
	const { start, end } = billingWindow(subscription, now);

	return {
		key: windowKey(userId, start, quotaGenerationOf(subscription)),
		config: { kind: 'fixed window' as const, period: STORAGE_PERIOD, rate: METER_CAPACITY, start },
		start,
		end
	};
}

async function usedInWindow(
	ctx: QueryCtx,
	meterId: UsageMeterId,
	userId: string,
	limits: TierLimits,
	subscription: MeterWindowSubscription | null,
	now: number
) {
	const window = meterWindowConfig(userId, subscription, now);

	const stored = await rateLimiter.getValue(ctx, meterLimitName(meterId), {
		key: window.key,
		config: window.config
	});

	if (stored.ts !== 0) {
		return { used: Math.max(0, METER_CAPACITY - stored.value), window, migrated: true };
	}

	const generation = quotaGenerationOf(subscription);

	// Generation 0 is the default window-key suffix (`resetAt ?? 0`). The
	// access backfill writes that sentinel when a row has no quotaResetAt, so
	// it must still read the legacy `userId` key instead of reporting 0 used.
	if (generation !== undefined && generation !== 0) {
		return { used: 0, window, migrated: true };
	}

	const oldConfig: RateLimitConfig = {
		kind: 'fixed window',
		period: 30 * DAY,
		rate: limits[meterId]
	};

	const old = await rateLimiter.getValue(ctx, meterLimitName(meterId), {
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

function meterLimitLabel(meterId: UsageMeterId): string {
	const meter = usageMeters.find((candidate) => candidate.id === meterId);

	if (!meter) throw new Error(`Unknown usage meter: ${meterId}`);

	return `${meter.label} limit`;
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
): Promise<{ retryAfter: number } | undefined> {
	const { window, used } = await usedInWindow(ctx, meterId, userId, limits, subscription, now);

	if (used < limits[meterId]) return undefined;

	return { retryAfter: Math.max(0, window.end - now) };
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
		`${meterLimitLabel(meterId)} reached. Try again in ${formatRetryAfter(blocked.retryAfter)}.`
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
		message: `${meterLimitLabel('modelUsage')} reached. Try again in ${formatRetryAfter(blocked.retryAfter)}.`
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
): Promise<boolean> {
	const { window, used, migrated } = await usedInWindow(
		ctx,
		meterId,
		userId,
		limits,
		subscription,
		now
	);

	await rateLimiter.limit(ctx, meterLimitName(meterId), {
		key: window.key,
		config: window.config,
		count: count + (migrated ? 0 : used),
		reserve: true
	});

	return used < limits[meterId] && used + count >= limits[meterId];
}

export async function getMeterWindow(
	ctx: QueryCtx,
	meterId: UsageMeterId,
	userId: string,
	limits: TierLimits,
	subscription: MeterWindowSubscription | null,
	now: number = Date.now()
): Promise<{ used: number; limit: number; resetsAt: number | null }> {
	const { used, window } = await usedInWindow(ctx, meterId, userId, limits, subscription, now);

	return {
		used,
		limit: limits[meterId],
		resetsAt: window.end
	};
}

export async function applyGatewayUsageCharge(
	ctx: GenericMutationCtx<DataModel>,
	userId: string,
	count: number
): Promise<void> {
	if (!Number.isFinite(count) || count <= 0) return;
	const now = Date.now();
	const { tier, subscription } = await ensureSubscription(ctx, userId, now);

	const exhausted = await chargeMeterLimits(
		ctx,
		'modelUsage',
		userId,
		await resolveTierLimits(ctx, tier),
		subscription,
		now,
		count
	);

	if (exhausted) {
		await posthog.capture(ctx, {
			distinctId: userId,
			event: 'quota_exhausted',
			properties: { tier }
		});
	}
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
