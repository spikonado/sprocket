import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, MutationCtx } from '@convex/_generated/server';

type ExecutionFields = Pick<
	Doc<'runExecutionStates'>,
	'claimId' | 'claimExpiresAt' | 'completionAttemptSeq' | 'activeJobId'
>;

export type ExecutionRun = Doc<'runs'> & ExecutionFields;

function executionFields(state: Doc<'runExecutionStates'>): ExecutionFields {
	return {
		claimId: state.claimId,
		claimExpiresAt: state.claimExpiresAt,
		completionAttemptSeq: state.completionAttemptSeq,
		activeJobId: state.activeJobId
	};
}

export async function getRunExecutionState(db: DatabaseReader, runId: Id<'runs'>) {
	return await db
		.query('runExecutionStates')
		.withIndex('by_runId', (query) => query.eq('runId', runId))
		.unique();
}

export async function withRunExecution(
	db: DatabaseReader,
	run: Doc<'runs'>
): Promise<ExecutionRun> {
	const state = await getRunExecutionState(db, run._id);
	if (!state) throw new Error('Run execution state not found.');
	return { ...run, ...executionFields(state) };
}

export async function getRunWithExecution(
	db: DatabaseReader,
	runId: Id<'runs'>
): Promise<ExecutionRun | null> {
	const run = await db.get('runs', runId);
	return run ? await withRunExecution(db, run) : null;
}

export async function patchRunExecution(
	ctx: MutationCtx,
	runId: Id<'runs'>,
	patch: Partial<ExecutionFields>
): Promise<void> {
	const state = await getRunExecutionState(ctx.db, runId);
	if (!state) throw new Error('Run execution state not found.');
	if (
		('claimId' in patch && state.claimId !== patch.claimId) ||
		('claimExpiresAt' in patch && state.claimExpiresAt !== patch.claimExpiresAt) ||
		('completionAttemptSeq' in patch &&
			state.completionAttemptSeq !== patch.completionAttemptSeq) ||
		('activeJobId' in patch && state.activeJobId !== patch.activeJobId)
	) {
		await ctx.db.patch('runExecutionStates', state._id, patch);
	}
}
