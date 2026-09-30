import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { getOwnedMachine, runMachineId } from '@convex/lib/machineRuns';
import { vSelectedThreadLifecycle } from '@convex/lib/docs';
import { projectSelectedThreadLifecycle } from '@convex/lib/runCancellation';

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
		const machineId = runMachineId(latestRun);
		if (machineId) {
			const machine = await getOwnedMachine(ctx, latestRun.userId, machineId);
			executorFriendlyName = machine?.friendlyName;
		}

		return projectSelectedThreadLifecycle({
			threadId: args.threadId,
			run: latestRun,
			waitingForInput: pendingQuestion !== null,
			executorFriendlyName
		});
	}
});
