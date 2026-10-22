import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import { posthog } from '@convex/lib/analytics';

const DAY_MS = 24 * 60 * 60 * 1000;

const PAGE_SIZE = 100;

const vPage = { dayStart: v.number(), cursor: v.union(v.string(), v.null()) };

// Per-user usage goes out as daily totals stamped at the day's start, so it can't be
// matched to the anonymous per-run and per-thread events by time.
export const sendDailyUsage = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const dayStart = now - (now % DAY_MS) - DAY_MS;
		await ctx.scheduler.runAfter(0, internal.analytics.sendDailyTokenUsage, {
			dayStart,
			cursor: null
		});
		await ctx.scheduler.runAfter(0, internal.analytics.sendDailyThreadsCreated, {
			dayStart,
			cursor: null
		});

		return null;
	}
});

export const sendDailyTokenUsage = internalMutation({
	args: vPage,
	returns: v.null(),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query('userTokenUsage')
			.withIndex('by_granularity_bucket', (query) =>
				query.eq('granularity', 'day').eq('bucketStart', args.dayStart)
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });

		for (const row of page.page) {
			await posthog.capture(ctx, {
				distinctId: row.userId,
				event: 'daily_token_usage',
				timestamp: new Date(args.dayStart),
				properties: {
					provider: row.provider,
					model: row.model,
					service_tier: row.serviceTier,
					calls: row.calls,
					input_tokens: row.standard.inputTokens + row.longContext.inputTokens,
					cache_read_tokens: row.standard.cacheReadTokens + row.longContext.cacheReadTokens,
					cache_write_tokens: row.standard.cacheWriteTokens + row.longContext.cacheWriteTokens,
					output_tokens: row.standard.outputTokens + row.longContext.outputTokens,
					reasoning_tokens: row.standard.reasoningTokens + row.longContext.reasoningTokens
				}
			});
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.analytics.sendDailyTokenUsage, {
				dayStart: args.dayStart,
				cursor: page.continueCursor
			});
		}

		return null;
	}
});

// A user's threads can span pages, so each page sends its own count and PostHog sums them.
export const sendDailyThreadsCreated = internalMutation({
	args: vPage,
	returns: v.null(),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query('threadRecords')
			.withIndex('by_creation_time', (query) =>
				query.gte('_creationTime', args.dayStart).lt('_creationTime', args.dayStart + DAY_MS)
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });

		const counts = new Map<string, number>();

		for (const thread of page.page) {
			counts.set(thread.userId, (counts.get(thread.userId) ?? 0) + 1);
		}

		for (const [userId, count] of counts) {
			await posthog.capture(ctx, {
				distinctId: userId,
				event: 'daily_threads_created',
				timestamp: new Date(args.dayStart),
				properties: { count }
			});
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.analytics.sendDailyThreadsCreated, {
				dayStart: args.dayStart,
				cursor: page.continueCursor
			});
		}

		return null;
	}
});
