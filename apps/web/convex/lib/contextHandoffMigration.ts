import type { Doc } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { EMPTY_CONTEXT_PREFIX_THROUGH_PART_NUMBER } from '@convex/lib/contextHandoff';

export async function migrateContextHandoffCutoff(
	ctx: MutationCtx,
	thread: Doc<'threadRecords'>
): Promise<void> {
	const throughRunId = thread.contextSummaryThroughRunId;

	if (throughRunId === undefined) return;

	let cutoff = thread.contextSummaryThroughPartNumber;

	if (cutoff === undefined) {
		const lastCovered = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_runId_and_number', (query) =>
				query.eq('threadId', thread._id).eq('runId', throughRunId)
			)
			.order('desc')
			.first();

		cutoff = lastCovered?.number ?? EMPTY_CONTEXT_PREFIX_THROUGH_PART_NUMBER;
	}

	await ctx.db.patch('threadRecords', thread._id, {
		contextSummaryThroughPartNumber: cutoff,
		contextSummaryThroughRunId: undefined
	});
}
