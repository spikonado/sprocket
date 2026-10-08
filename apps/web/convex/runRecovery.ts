import { query } from '@convex/_generated/server';
import { getUserId } from '@convex/lib/auth';
import { isAutomaticallyRecoverableRun } from '@convex/lib/runRecovery';
import { threadRoot } from '@convex/lib/threadHierarchy';
import { v, type Infer } from 'convex/values';

const vRecoveryState = v.union(
	v.object({ state: v.literal('discard') }),
	v.object({ state: v.literal('pending') }),
	v.object({ state: v.literal('missing') }),
	v.object({ state: v.literal('recover'), runId: v.id('runs'), threadId: v.id('threadRecords') })
);

export const state = query({
	args: {
		submissionId: v.string(),
		machineId: v.string(),
		continuationOfRunId: v.optional(v.id('runs'))
	},
	returns: vRecoveryState,
	handler: async (ctx, args): Promise<Infer<typeof vRecoveryState>> => {
		const userId = await getUserId(ctx);

		const submitted = await ctx.db
			.query('runs')
			.withIndex('by_userId_submissionId', (q) =>
				q.eq('userId', userId).eq('submissionId', args.submissionId)
			)
			.unique();

		const run =
			submitted ??
			(args.continuationOfRunId ? await ctx.db.get('runs', args.continuationOfRunId) : null);

		if (!run || run.userId !== userId || run.machineId !== args.machineId) {
			return { state: 'discard' };
		}

		const latest = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', run.threadId))
			.order('desc')
			.first();

		const thread = await ctx.db.get('threadRecords', run.threadId);

		if (
			latest?._id !== run._id ||
			!thread ||
			(await threadRoot(ctx.db, thread)).archivedAt !== undefined
		) {
			return { state: 'discard' };
		}

		if (isAutomaticallyRecoverableRun(run, args.machineId)) {
			return submitted
				? { state: 'recover', runId: run._id, threadId: run.threadId }
				: { state: 'missing' };
		}

		return submitted && (run.status === 'queued' || run.status === 'running')
			? { state: 'pending' }
			: { state: 'discard' };
	}
});
