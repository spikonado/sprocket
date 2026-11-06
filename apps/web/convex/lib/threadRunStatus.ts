import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import type { vRunStatus } from '@convex/lib/validators';
import { changeThreadActivity } from '@convex/lib/threadHierarchy';

export async function insertQueuedRun(
	ctx: MutationCtx,
	run: Omit<Doc<'runs'>, '_id' | '_creationTime' | 'status'>
): Promise<Id<'runs'>> {
	return await changeThreadActivity(ctx, run.threadId, async () => {
		const runId = await ctx.db.insert('runs', { ...run, status: 'queued' });
		await mirrorLatestRunStatus(ctx, run.threadId);

		return runId;
	});
}

export async function setRunAndThreadStatus(
	ctx: MutationCtx,
	run: Pick<Doc<'runs'>, '_id' | 'threadId' | 'status'>,
	status: Infer<typeof vRunStatus>,
	runPatch: Partial<Pick<Doc<'runs'>, 'completedAt' | 'lastError' | 'failureKind'>> = {}
): Promise<void> {
	const current = await ctx.db.get('runs', run._id);

	if (!current) throw new Error('Run not found.');

	await changeThreadActivity(ctx, current.threadId, async () => {
		if (
			current.status !== status ||
			('completedAt' in runPatch && current.completedAt !== runPatch.completedAt) ||
			('lastError' in runPatch && current.lastError !== runPatch.lastError) ||
			('failureKind' in runPatch && current.failureKind !== runPatch.failureKind)
		) {
			await ctx.db.patch('runs', run._id, { ...runPatch, status });
		}

		await mirrorLatestRunStatus(ctx, run.threadId);
	});
}

async function mirrorLatestRunStatus(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const [latestRun, thread] = await Promise.all([
		ctx.db
			.query('runs')
			.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
			.order('desc')
			.first(),
		ctx.db.get('threadRecords', threadId)
	]);

	if (latestRun && thread && thread.status !== latestRun.status) {
		await ctx.db.patch('threadRecords', threadId, { status: latestRun.status });
	}
}
