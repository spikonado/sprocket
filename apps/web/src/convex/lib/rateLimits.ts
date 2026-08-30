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

async function meterWindowForKey(
	ctx: RunQueryCtx,
	key: string,
	name: string,
	config: RateLimitConfig
): Promise<MeterWindow> {
	const stored = await ctx.runQuery(components.rateLimiter.lib.getValue, {
		name,
		key,
		config
	});
	return {
		value: stored.value,
		ts: stored.ts,
		shard: stored.shard,
		config
	};
}

/** Canonical plus legacy-subject windows. Charge writes one key; a weekly
 * reset can still leave usage on both until those windows roll, so readers
 * add them. */
async function ownerMeterWindows(
	ctx: RunQueryCtx,
	userId: string,
	name: string,
	config: RateLimitConfig
): Promise<MeterWindow[]> {
	const canonical = await meterWindowForKey(ctx, userId, name, config);
	const subject = await ctx.runQuery(internal.lib.auth.storedOwnerSubject, { userId });
	if (!subject || subject === userId) return [canonical];
	return [canonical, await meterWindowForKey(ctx, subject, name, config)];
}

function windowUsed(window: MeterWindow, now: number): number {
	if (window.ts === 0) return 0;
	const current = calculateRateLimit({ value: window.value, ts: window.ts }, window.config, now);
	return Math.max(0, window.config.rate - current.value);
}

/** How long until combined used falls back under `limit` as windows reset. */
function combinedRetryAfter(windows: MeterWindow[], limit: number, now: number): number {
	const active = windows
		.map((window) => ({
			used: windowUsed(window, now),
			resetAt: window.ts + window.config.period
		}))
		.filter((window) => window.used > 0)
		.sort((left, right) => left.resetAt - right.resetAt);
	let remaining = active.reduce((sum, window) => sum + window.used, 0);
	for (const window of active) {
		remaining -= window.used;
		if (remaining < limit) return Math.max(SECOND, window.resetAt - now);
	}
	const last = active.at(-1);
	return last ? Math.max(SECOND, last.resetAt - now) : 0;
}

/** The original whose window reports more usage (or the only one started). */
function largestMeterWindow(left: MeterWindow, right: MeterWindow): MeterWindow {
	if (left.ts === 0) return right;
	if (right.ts === 0) return left;
	// Fixed-window shards keep usage as (rate - value); older windows have
	// decayed further, so the larger user-visible used amount is the tighter
	// bound for charge-key selection.
	const leftUsed = Math.max(0, left.config.rate - left.value);
	const rightUsed = Math.max(0, right.config.rate - right.value);
	// Shard zero holds the full window; nonzero shards are partial chunks.
	if (left.shard === 0 && right.shard !== 0) return left;
	if (right.shard === 0 && left.shard !== 0) return right;
	return leftUsed >= rightUsed ? left : right;
}

async function blockedMeterLimit(
	ctx: RunMutationCtx,
	meterId: UsageMeterId,
	key: string,
	limits: TierLimits,
	now: number = Date.now()
): Promise<{ period: UsagePeriod; retryAfter: number } | undefined> {
	const blocked = (
		await Promise.all(
			usagePeriods.map(async (period) => {
				const config = meterLimitConfig(meterId, period, limits);
				const windows = await ownerMeterWindows(ctx, key, meterLimitName(meterId, period), config);
				const used = windows.reduce((sum, window) => sum + windowUsed(window, now), 0);
				if (used < config.rate) return undefined;
				return { period, retryAfter: combinedRetryAfter(windows, config.rate, now) };
			})
		)
	)
		.filter((entry) => entry !== undefined)
		.sort((left, right) => right.retryAfter - left.retryAfter)[0];
	return blocked;
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

/** Prefer the key that already has an open window so a weekly reset cannot
 *  open a fresh monthly window on the other key. Monthly is checked first
 *  because it outlives the weekly meter. */
function chargeKeyForWindows(
	userId: string,
	subject: string,
	canonical: MeterWindow,
	legacy: MeterWindow
): string | undefined {
	if (legacy.ts === 0 && canonical.ts === 0) return undefined;
	if (legacy.ts === 0) return userId;
	if (canonical.ts === 0) return subject;
	return largestMeterWindow(canonical, legacy) === canonical ? userId : subject;
}

async function chargeOwnerKey(
	ctx: RunQueryCtx,
	userId: string,
	meterId: UsageMeterId,
	limits: TierLimits
): Promise<string> {
	const subject = await ctx.runQuery(internal.lib.auth.storedOwnerSubject, { userId });
	if (!subject || subject === userId) return userId;
	for (const period of ['monthly', 'weekly'] as const) {
		const config = meterLimitConfig(meterId, period, limits);
		const name = meterLimitName(meterId, period);
		const chargeKey = chargeKeyForWindows(
			userId,
			subject,
			await meterWindowForKey(ctx, userId, name, config),
			await meterWindowForKey(ctx, subject, name, config)
		);
		if (chargeKey) return chargeKey;
	}
	return userId;
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
	const windows = await ownerMeterWindows(ctx, userId, meterLimitName(meterId, period), config);
	const used = windows.reduce((sum, window) => sum + windowUsed(window, now), 0);
	if (used === 0) return { used: 0, limit: config.rate, resetsAt: null };
	const resetsAt = Math.min(
		...windows
			.filter((window) => windowUsed(window, now) > 0)
			.map((window) => window.ts + window.config.period)
	);
	return { used, limit: config.rate, resetsAt };
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
