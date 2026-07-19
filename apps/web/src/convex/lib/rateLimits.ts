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
import { components, internal } from '@convex/_generated/api';
import { internalMutation, type ActionCtx, type MutationCtx } from '@convex/_generated/server';
import { getFunctionName, type FunctionArgs, type FunctionReference } from 'convex/server';
import { v } from 'convex/values';
import {
	completionUsageUnits,
	type SupportedModelId,
	type SupportedServiceTier
} from '@convex/lib/models';
import { getSubscriptionTier, tierLimits, type TierLimits } from '@convex/lib/tiers';
import { vModelId, vServiceTier } from '@convex/lib/validators';

const MONTH = 30 * DAY;
/** Flat web-tools meter cost for one URL scrape. */
export const URL_SCRAPE_USAGE_UNITS = 1.5;
/** Flat web-tools meter cost for one web search (independent of result count). */
export const WEB_SEARCH_USAGE_UNITS = 7;
export const rateLimiter = new RateLimiter(components.rateLimiter, {});

export const usageMeters = [
	{
		id: 'modelUsage',
		label: 'Model usage',
		noun: 'model usage',
		description: 'More expensive models use up more usage.'
	},
	{
		id: 'webTools',
		label: 'Web tools',
		noun: 'web tools',
		description: 'Web search and URL scrape share this quota.'
	}
] as const;

export type UsageMeterId = (typeof usageMeters)[number]['id'];

export const usagePeriods = ['weekly', 'monthly'] as const;
export type UsagePeriod = (typeof usagePeriods)[number];

const periodDurations: Record<UsagePeriod, number> = { weekly: WEEK, monthly: MONTH };

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
	const meter = usageMeters.find(({ id }) => id === meterId);
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

function rateLimitError(label: string, retryAfter: number, cause?: unknown): Error {
	return new Error(`${label} reached. Try again in ${formatRetryAfter(retryAfter)}.`, { cause });
}

async function checkMeterLimits(
	ctx: RunMutationCtx,
	meterId: UsageMeterId,
	key: string,
	limits: TierLimits
): Promise<void> {
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
		throw rateLimitError(meterLimitLabel(meterId, blocked.period), blocked.status.retryAfter);
	}
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
	limits: TierLimits
): Promise<{ used: number; limit: number; resetsAt: number | null }> {
	const config = meterLimitConfig(meterId, period, limits);
	const stored = await rateLimiter.getValue(ctx, meterLimitName(meterId, period), {
		key: userId,
		config
	});
	// A fixed window starts on first use; ts === 0 means it never has.
	if (stored.ts === 0) return { used: 0, limit: config.rate, resetsAt: null };
	const current = calculateRateLimit({ value: stored.value, ts: stored.ts }, config, Date.now());
	return {
		used: Math.max(0, config.rate - current.value),
		limit: config.rate,
		resetsAt: current.ts + config.period
	};
}

async function chargeWebTools(ctx: MutationCtx, userId: string, count: number): Promise<void> {
	const tier = await getSubscriptionTier(ctx, userId);
	await chargeMeterLimits(ctx, 'webTools', userId, tierLimits[tier], count);
}

export const checkWebToolsLimits = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		const tier = await getSubscriptionTier(ctx, userId);
		await checkMeterLimits(ctx, 'webTools', userId, tierLimits[tier]);
	}
});

export const chargeUrlScrapeLimits = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		await chargeWebTools(ctx, userId, URL_SCRAPE_USAGE_UNITS);
	}
});

export const chargeWebSearchLimits = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		await chargeWebTools(ctx, userId, WEB_SEARCH_USAGE_UNITS);
	}
});

export const checkModelUsageLimits = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		const tier = await getSubscriptionTier(ctx, userId);
		await checkMeterLimits(ctx, 'modelUsage', userId, tierLimits[tier]);
	}
});

export const chargeModelUsageLimits = internalMutation({
	args: {
		userId: v.string(),
		modelId: vModelId,
		serviceTier: vServiceTier,
		tokens: v.object({
			input: v.number(),
			cacheRead: v.number(),
			cacheWrite: v.number(),
			output: v.number()
		})
	},
	handler: async (ctx, args) => {
		const tier = await getSubscriptionTier(ctx, args.userId);
		const count = completionUsageUnits(args.modelId, args.serviceTier, args.tokens);
		await chargeMeterLimits(ctx, 'modelUsage', args.userId, tierLimits[tier], count);
	}
});

// Usage was already provided when these run, so accounting must not fail the
// caller: fall back to a durable scheduled charge, and as a last resort log.
async function chargeUsageDurably<Mutation extends FunctionReference<'mutation', 'internal'>>(
	ctx: ActionCtx,
	mutation: Mutation,
	args: FunctionArgs<Mutation>
): Promise<void> {
	try {
		await ctx.runMutation(mutation, args);
	} catch (chargeError) {
		try {
			await ctx.scheduler.runAfter(0, mutation, args);
		} catch (scheduleError) {
			console.error(
				`Failed to charge usage (${getFunctionName(mutation)}).`,
				args,
				chargeError,
				scheduleError
			);
		}
	}
}

export async function checkModelUsageLimit(ctx: ActionCtx, userId: string): Promise<void> {
	await ctx.runMutation(internal.lib.rateLimits.checkModelUsageLimits, { userId });
}

export async function chargeModelUsage(
	ctx: ActionCtx,
	args: {
		userId: string;
		modelId: SupportedModelId;
		serviceTier: SupportedServiceTier;
		tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
	}
): Promise<void> {
	await chargeUsageDurably(ctx, internal.lib.rateLimits.chargeModelUsageLimits, args);
}

export async function checkWebToolsLimit(ctx: ActionCtx, userId: string): Promise<void> {
	await ctx.runMutation(internal.lib.rateLimits.checkWebToolsLimits, { userId });
}

export async function chargeUrlScrapeUsage(ctx: ActionCtx, userId: string): Promise<void> {
	await chargeUsageDurably(ctx, internal.lib.rateLimits.chargeUrlScrapeLimits, { userId });
}

export async function chargeWebSearchUsage(ctx: ActionCtx, userId: string): Promise<void> {
	await chargeUsageDurably(ctx, internal.lib.rateLimits.chargeWebSearchLimits, { userId });
}
