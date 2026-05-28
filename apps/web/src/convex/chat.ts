import type { Doc } from '@convex/_generated/dataModel';
import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';

export const latestRunForThread = query({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.id('threadRecords')
	},
	handler: async (ctx, args): Promise<{ run: Doc<'runs'>; jobs: Doc<'executorJobs'>[] } | null> => {
		const userId: string = await getUserId(ctx, args.guestId);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const latestRun: Doc<'runs'> | null = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		if (!latestRun) {
			return null;
		}

		const jobs: Doc<'executorJobs'>[] = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_sequence', (query) => query.eq('runId', latestRun._id))
			.collect();

		return {
			run: latestRun,
			jobs: jobs.filter((job) => !job.hidden).sort((left, right) => left.sequence - right.sequence)
		};
	}
});
