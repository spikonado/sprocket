import {
	DAY,
	RateLimiter,
	WEEK,
	calculateRateLimit,
	type RateLimitConfig,
	type RunMutationCtx,
	type RunQueryCtx
} from '@convex-dev/rate-limiter';
import { components, internal } from '@convex/_generated/api';
import { internalMutation, type ActionCtx } from '@convex/_generated/server';
import { getFunctionName, type FunctionArgs, type FunctionReference } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import {
	completionUsageUnits,
	isModelUsageMetered,
	type SupportedModelId,
	type SupportedServiceTier
} from '@convex/lib/models';
import { ensureSubscription, tierLimits, type TierLimits } from '@convex/lib/tiers';
import { usageLimitExhaustedMessage } from '@convex/lib/usageLimitErrors';
import {
	usageMeters,
	usagePeriods,
	type UsageMeterId,
	type UsagePeriod
} from '@convex/lib/usageMeters';
import { vModelId, vServiceTier } from '@convex/lib/validators';

export { usageMeters, usagePeriods, type UsageMeterId, type UsagePeriod };

const MONTH = 30 * DAY;
export const rateLimiter = new RateLimiter(components.rateLimiter, {});

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
		// A ConvexError keeps its message through production error masking, and
		// the executor only retries masked server failures.
		throw new ConvexError(
			usageLimitExhaustedMessage({
				meterId,
				period: blocked.period,
				resetsAt: Date.now() + blocked.status.retryAfter
			})
		);
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

export const checkModelUsageLimits = internalMutation({
	args: { userId: v.string(), modelId: vModelId },
	handler: async (ctx, { userId, modelId }) => {
		if (!isModelUsageMetered(modelId)) return;
		const tier = await ensureSubscription(ctx, userId);
		if (tier === 'admin') return;
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
		if (!isModelUsageMetered(args.modelId)) return;
		const tier = await ensureSubscription(ctx, args.userId);
		if (tier === 'admin') return;
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

export async function checkModelUsageLimit(
	ctx: ActionCtx,
	userId: string,
	modelId: SupportedModelId
): Promise<void> {
	await ctx.runMutation(internal.lib.rateLimits.checkModelUsageLimits, { userId, modelId });
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
