import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';

export type ThreadTranscriptMessage = Doc<'threadMessages'> & {
	runStatus: Doc<'runs'>['status'];
	runStartedAt: number;
	runCompletedAt?: number;
};

export async function buildThreadTranscript(
	ctx: MutationCtx | QueryCtx,
	threadId: Id<'threadRecords'>
): Promise<ThreadTranscriptMessage[]> {
	const runs: Doc<'runs'>[] = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
		.collect();
	const transcriptMessages: ThreadTranscriptMessage[] = [];

	for (const run of runs) {
		for (const messageId of [run.promptMessageId, run.responseMessageId]) {
			if (!messageId) {
				continue;
			}
			const message: Doc<'threadMessages'> | null = await ctx.db.get(messageId);
			if (!message) {
				continue;
			}

			transcriptMessages.push({
				...message,
				runStatus: run.status,
				runStartedAt: run.startedAt,
				runCompletedAt: run.completedAt
			});
		}
	}

	return transcriptMessages;
}
