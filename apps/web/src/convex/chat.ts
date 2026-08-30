import { query } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getOwnerKeys } from '@convex/lib/auth';
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
		const keys = await getOwnerKeys(ctx);
		await getOwnedThreadRecord(ctx.db, keys, args.threadId);
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
				jobs: [],
				prompt: undefined,
				imageUploadIds: undefined,
				serverNow
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
			? await ctx.db.get('threadMessages', latestRun.promptMessageId)
			: null;

		const latest: Infer<typeof vLatestRunForThread> = {
			threadId: args.threadId,
			run: latestRun,
			jobs: jobs.reverse(),
			serverNow
		};
		if (promptMessage?.type === 'prompt') {
			latest.prompt = promptMessage.text;
			latest.imageUploadIds = promptMessage.imageUploadIds ?? [];
		}
		return latest;
	}
});
