import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { vLatestRunForThread } from '@convex/lib/docs';

export const latestRunForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vLatestRunForThread,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const latestRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		if (!latestRun) {
			return {
				threadId: args.threadId,
				run: null,
				jobs: [],
				prompt: undefined,
				imageUploadIds: undefined,
				serverNow: Date.now()
			};
		}

		const jobs = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_hidden_sequence', (query) =>
				query.eq('runId', latestRun._id).eq('hidden', false)
			)
			.order('desc')
			.take(60);
		const promptMessage = latestRun.promptMessageId
			? await ctx.db.get(latestRun.promptMessageId)
			: null;

		return {
			threadId: args.threadId,
			run: latestRun,
			jobs: jobs.reverse(),
			...(promptMessage?.type === 'prompt'
				? {
						prompt: promptMessage.text,
						imageUploadIds: promptMessage.imageUploadIds ?? []
					}
				: {}),
			serverNow: Date.now()
		};
	}
});
