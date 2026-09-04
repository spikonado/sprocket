import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';

export async function getCompletionStreamState(
	ctx: MutationCtx | QueryCtx,
	run: Doc<'runs'>
): Promise<Doc<'completionStreamStates'>> {
	if (!run.completionStreamStateId) {
		throw new Error('Run does not contain completion stream state.');
	}
	const state = await ctx.db.get('completionStreamStates', run.completionStreamStateId);
	if (!state || state.runId !== run._id || state.userId !== run.userId) {
		throw new Error('Completion stream state is invalid.');
	}
	return state;
}

export async function registerCompletionAttemptForRun(
	ctx: MutationCtx,
	run: Doc<'runs'>,
	attemptSeq: number
): Promise<void> {
	// Partial superseded turns are discarded on the agent side, not in Convex.
	await ctx.db.patch('runs', run._id, { completionAttemptSeq: attemptSeq });
}
