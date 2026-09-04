import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { getOwnedMachine, runMachineId } from '@convex/lib/machineRuns';
import { vSelectedThreadLifecycle } from '@convex/lib/docs';
import { projectSelectedThreadLifecycle } from '@convex/lib/runCancellation';
import { unsupportedClient } from '@convex/lib/unsupportedClient';

/** Retired UI run query. Current clients read `selectedThreadLifecycle`. */
export const latestRunForThread = query({
	args: {
		threadId: v.id('threadRecords'),
		now: v.optional(v.number())
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const selectedThreadLifecycle = query({
	args: {
		threadId: v.id('threadRecords'),
		// Callers that can refresh should pass wall-clock time so overdue ask
		// questions stop counting as waiting_for_input without a DB write.
		now: v.optional(v.number())
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

		const now = args.now ?? Date.now();
		const pendingQuestions = await ctx.db
			.query('agentQuestions')
			.withIndex('by_threadId_status_sequence', (query) =>
				query.eq('threadId', args.threadId).eq('status', 'pending')
			)
			.collect();
		const waitingForInput = pendingQuestions.some((question) => question.timeoutAt > now);
		let executorFriendlyName: string | undefined;
		const machineId = runMachineId(latestRun);
		if (machineId) {
			const machine = await getOwnedMachine(ctx, latestRun.userId, machineId);
			executorFriendlyName = machine?.friendlyName;
		}

		return projectSelectedThreadLifecycle({
			threadId: args.threadId,
			run: latestRun,
			waitingForInput,
			executorFriendlyName
		});
	}
});
