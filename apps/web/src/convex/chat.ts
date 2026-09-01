import { query } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { vLatestRunForThread, vSelectedThreadLifecycle } from '@convex/lib/docs';
import { projectSelectedThreadLifecycle } from '@convex/lib/runCancellation';

/** Compatibility shim. Current UI reads `selectedThreadLifecycle`. */
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

export const selectedThreadLifecycle = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vSelectedThreadLifecycle,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const latestRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.order('desc')
			.first();
		if (!latestRun) {
			return projectSelectedThreadLifecycle({
				threadId: args.threadId,
				run: null,
				waitingForInput: false
			});
		}

		const pendingQuestion = await ctx.db
			.query('agentQuestions')
			.withIndex('by_threadId_status_sequence', (query) =>
				query.eq('threadId', args.threadId).eq('status', 'pending')
			)
			.first();
		let executorFriendlyName: string | undefined;
		if (latestRun.installationId) {
			const installation = await ctx.db
				.query('installations')
				.withIndex('by_userId_and_installationId', (query) =>
					query.eq('userId', latestRun.userId).eq('installationId', latestRun.installationId!)
				)
				.unique();
			executorFriendlyName = installation?.friendlyName;
		}

		return projectSelectedThreadLifecycle({
			threadId: args.threadId,
			run: latestRun,
			waitingForInput: pendingQuestion !== null,
			executorFriendlyName
		});
	}
});
