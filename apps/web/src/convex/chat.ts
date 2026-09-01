import { query } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { vLatestRunForThread } from '@convex/lib/docs';

export const latestRunForThread = query({
	args: {
		threadId: v.id('threadRecords'),
		// Callers that can refresh should pass wall-clock time. Omitted `now`
		// keeps the Svelte page (which only sends threadId) working.
		now: v.optional(v.number())
	},
	returns: vLatestRunForThread,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const serverNow = args.now ?? Date.now();

		const latestRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		if (!latestRun) {
			return {
				threadId: args.threadId,
				run: null,
				activeJob: null,
				prompt: undefined,
				imageUploadIds: undefined,
				serverNow
			};
		}

		const activeJob = latestRun.activeJobId
			? await ctx.db.get('executorJobs', latestRun.activeJobId)
			: null;
		const promptMessage = latestRun.promptMessageId
			? await ctx.db.get('threadMessages', latestRun.promptMessageId)
			: null;

		const latest: Infer<typeof vLatestRunForThread> = {
			threadId: args.threadId,
			run: latestRun,
			activeJob: activeJob?.hidden ? null : activeJob,
			serverNow
		};
		if (promptMessage?.type === 'prompt') {
			latest.prompt = promptMessage.text;
			latest.imageUploadIds = promptMessage.imageUploadIds ?? [];
		}
		return latest;
	}
});
