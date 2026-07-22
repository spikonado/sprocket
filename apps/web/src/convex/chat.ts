import type { Doc, Id } from '@convex/_generated/dataModel';
import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';

export const latestRunForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	handler: async (
		ctx,
		args
	): Promise<{
		threadId: typeof args.threadId;
		run: Doc<'runs'> | null;
		jobs: Doc<'executorJobs'>[];
		prompt?: string;
		imageUploadIds?: Id<'imageUploads'>[];
		serverNow: number;
	}> => {
		const userId: string = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const latestRun: Doc<'runs'> | null = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		if (!latestRun) {
			return {
				threadId: args.threadId,
				run: null,
				jobs: [],
				serverNow: Date.now()
			};
		}

		const jobs: Doc<'executorJobs'>[] = await ctx.db
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
