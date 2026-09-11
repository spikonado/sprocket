import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import type { vRunStatus } from '@convex/lib/validators';

export async function setRunAndThreadStatus(
	ctx: MutationCtx,
	run: Pick<Doc<'runs'>, '_id' | 'threadId' | 'status'>,
	status: Infer<typeof vRunStatus>,
	runPatch: Partial<Pick<Doc<'runs'>, 'completedAt' | 'lastError'>> = {}
): Promise<void> {
	const current = await ctx.db.get('runs', run._id);
	if (!current) throw new Error('Run not found.');
	const nextStatus = status === 'awaiting_executor' ? 'running' : status;
	if (
		current.status !== nextStatus ||
		('completedAt' in runPatch && current.completedAt !== runPatch.completedAt) ||
		('lastError' in runPatch && current.lastError !== runPatch.lastError)
	) {
		await ctx.db.patch('runs', run._id, { ...runPatch, status: nextStatus });
	}
	const [latestRun, thread] = await Promise.all([
		ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', run.threadId))
			.order('desc')
			.first(),
		ctx.db.get('threadRecords', run.threadId)
	]);
	if (!latestRun || !thread) return;
	const threadStatus = latestRun.status === 'awaiting_executor' ? 'running' : latestRun.status;
	if (thread.status !== threadStatus) {
		await ctx.db.patch('threadRecords', run.threadId, { status: threadStatus });
	}
}
