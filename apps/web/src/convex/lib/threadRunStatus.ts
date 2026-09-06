import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import type { vRunStatus } from '@convex/lib/validators';

export async function setRunAndThreadStatus(
	ctx: MutationCtx,
	run: Pick<Doc<'runs'>, '_id' | 'threadId' | 'status'>,
	status: Infer<typeof vRunStatus>,
	runPatch: Partial<
		Pick<
			Doc<'runs'>,
			| 'activeJobId'
			| 'claimExpiresAt'
			| 'claimId'
			| 'completedAt'
			| 'completionAttemptSeq'
			| 'lastError'
		>
	> = {}
): Promise<void> {
	await ctx.db.patch('runs', run._id, { ...runPatch, status });
	const [latestRun, thread] = await Promise.all([
		ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', run.threadId))
			.order('desc')
			.first(),
		ctx.db.get('threadRecords', run.threadId)
	]);
	if (!latestRun || !thread || thread.status === latestRun.status) return;
	await ctx.db.patch('threadRecords', run.threadId, {
		status: latestRun.status,
		updatedAt: Date.now()
	});
}
