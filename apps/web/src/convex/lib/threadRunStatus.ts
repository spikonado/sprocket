import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import type { vRunStatus } from '@convex/lib/validators';
import { patchInboxThread, wakeInboxThread } from './inbox';
import { inboxState, runningStatus } from './inboxState';

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
	const lastCompletedAt = latestRun.completedAt ?? thread.lastCompletedAt;
	if (
		thread.status !== threadStatus ||
		thread.lastCompletedAt !== lastCompletedAt ||
		thread.lastRunStartedAt !== latestRun.startedAt
	) {
		const terminalEvent =
			latestRun._id === current._id &&
			!runningStatus(threadStatus) &&
			(current.status !== nextStatus || current.completedAt !== latestRun.completedAt);
		const wake = inboxState(thread) === 'snoozed' && terminalEvent;
		await patchInboxThread(ctx, thread, {
			status: threadStatus,
			lastRunStartedAt: latestRun.startedAt,
			lastCompletedAt
		});
		if (wake) await wakeInboxThread(ctx, thread);
	}
}
