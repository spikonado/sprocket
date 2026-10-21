import { query, type QueryCtx } from '@convex/_generated/server';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { v } from 'convex/values';
import { getOwnedRun, getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { sumModelCalls } from '@convex/lib/tokenUsage';
import { vTokenUsageTotals, type TokenUsageTotals } from '@convex/lib/validators';

const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_RANGE_MS = { hour: 2 * DAY_MS, day: 400 * DAY_MS } as const;

function totalsOf(rows: readonly Doc<'threadTokenUsage'>[]): TokenUsageTotals[] {
	return rows.map(
		({ provider, model, serviceTier, cacheWriteTtl, calls, standard, longContext }) => ({
			provider,
			model,
			serviceTier,
			cacheWriteTtl,
			calls,
			standard,
			longContext
		})
	);
}

async function threadTotals(ctx: QueryCtx, threadId: Id<'threadRecords'>) {
	return totalsOf(
		await ctx.db
			.query('threadTokenUsage')
			.withIndex('by_threadId_model', (q) => q.eq('threadId', threadId))
			.collect()
	);
}

/** The thread's own totals, plus every descendant subagent thread's totals. */
export const getThreadUsage = query({
	args: { threadId: v.id('threadRecords') },
	returns: v.object({
		totals: v.array(vTokenUsageTotals),
		subagents: v.array(
			v.object({
				threadId: v.id('threadRecords'),
				title: v.optional(v.string()),
				totals: v.array(vTokenUsageTotals)
			})
		)
	}),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const subagents = [];
		const pending = [thread._id];

		for (let parentId = pending.pop(); parentId; parentId = pending.pop()) {
			const children = await ctx.db
				.query('threadRecords')
				.withIndex('by_userId_parentThreadId', (q) =>
					q.eq('userId', userId).eq('parentThreadId', parentId)
				)
				.collect();

			for (const child of children) {
				pending.push(child._id);
				subagents.push({
					threadId: child._id,
					title: child.title,
					totals: await threadTotals(ctx, child._id)
				});
			}
		}

		return { totals: await threadTotals(ctx, thread._id), subagents };
	}
});

export const getRunUsage = query({
	args: { runId: v.id('runs') },
	returns: v.array(vTokenUsageTotals),
	handler: async (ctx, args) => {
		const run = await getOwnedRun(ctx.db, await getUserId(ctx), args.runId);

		const calls = await ctx.db
			.query('modelCallUsage')
			.withIndex('by_runId_eventId', (q) => q.eq('runId', run._id))
			.collect();

		return sumModelCalls(calls);
	}
});

/** UTC buckets with `from <= bucketStart < to`. */
export const getMyUsageBuckets = query({
	args: {
		granularity: v.union(v.literal('hour'), v.literal('day')),
		from: v.number(),
		to: v.number()
	},
	returns: v.array(v.object({ bucketStart: v.number(), ...vTokenUsageTotals.fields })),
	handler: async (ctx, args) => {
		if (!(args.from <= args.to && args.to - args.from <= MAX_RANGE_MS[args.granularity])) {
			throw new Error('Usage range is invalid or too long.');
		}

		const userId = await getUserId(ctx);

		const rows = await ctx.db
			.query('userTokenUsage')
			.withIndex('by_userId_bucket', (q) =>
				q
					.eq('userId', userId)
					.eq('granularity', args.granularity)
					.gte('bucketStart', args.from)
					.lt('bucketStart', args.to)
			)
			.collect();

		return rows.map(
			({
				bucketStart,
				provider,
				model,
				serviceTier,
				cacheWriteTtl,
				calls,
				standard,
				longContext
			}) => ({
				bucketStart,
				provider,
				model,
				serviceTier,
				cacheWriteTtl,
				calls,
				standard,
				longContext
			})
		);
	}
});
