import type { Doc } from '@convex/_generated/dataModel';
import type { QueryCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import type { vRecordedWorkspaceContext } from '@convex/lib/docs';

/** The context shown in the thread's current history, from its last handoff on. */
export async function recordedWorkspaceContext(
	ctx: QueryCtx,
	thread: Doc<'threadRecords'>
): Promise<Infer<typeof vRecordedWorkspaceContext>> {
	const base = thread.contextSummaryHandoffKey
		? await ctx.db
				.query('threadWorkspaceContexts')
				.withIndex('by_threadId_and_handoffKey', (query) =>
					query.eq('threadId', thread._id).eq('handoffKey', thread.contextSummaryHandoffKey)
				)
				.unique()
		: null;

	const updates = await ctx.db
		.query('threadWorkspaceContexts')
		.withIndex('by_threadId_and_handoffKey', (query) => {
			const rows = query.eq('threadId', thread._id).eq('handoffKey', undefined);

			return base ? rows.gt('_creationTime', base._creationTime) : rows;
		})
		.collect();

	return {
		...(base && { base: base.context }),
		updates: updates.map((row) => ({ runId: row.runId, context: row.context }))
	};
}
