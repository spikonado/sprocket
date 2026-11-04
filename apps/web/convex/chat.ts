import { query, type QueryCtx } from '@convex/_generated/server';
import { v, type ObjectType } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { getOwnedMachine, runMachineId } from '@convex/lib/machineRuns';
import { vSelectedThreadLifecycle } from '@convex/lib/docs';
import { projectSelectedThreadLifecycle } from '@convex/lib/runCancellation';
import { headActionablePendingQuestion } from '@convex/lib/agentQuestions';

const selectedThreadLifecycleArgs = {
	threadId: v.id('threadRecords')
};

export async function selectedThreadLifecycleHandler(
	ctx: QueryCtx,
	args: ObjectType<typeof selectedThreadLifecycleArgs>
) {
	const userId = await getUserId(ctx);
	await getOwnedThreadRecord(ctx.db, userId, args.threadId);

	const latestRun = await ctx.db
		.query('runs')
		.withIndex('by_threadId', (query) => query.eq('threadId', args.threadId))
		.order('desc')
		.first();

	if (!latestRun) {
		return projectSelectedThreadLifecycle({
			threadId: args.threadId,
			run: null,
			waitingForInput: false
		});
	}

	const pendingQuestion = await headActionablePendingQuestion(ctx.db, args.threadId);

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

export const selectedThreadLifecycle = query({
	args: selectedThreadLifecycleArgs,
	returns: vSelectedThreadLifecycle,
	handler: selectedThreadLifecycleHandler
});
