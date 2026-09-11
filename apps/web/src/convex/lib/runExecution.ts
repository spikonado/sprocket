import type { Doc, Id } from '@convex/_generated/dataModel';
import type { DatabaseReader, MutationCtx } from '@convex/_generated/server';

type ExecutionFields = Pick<
	Doc<'runExecutionStates'>,
	'claimId' | 'claimExpiresAt' | 'completionAttemptSeq' | 'activeJobId'
>;

export type ExecutionRun = Doc<'runs'> & ExecutionFields;

function executionFields(run: Doc<'runs'> | Doc<'runExecutionStates'>): ExecutionFields {
	return {
		claimId: run.claimId,
		claimExpiresAt: run.claimExpiresAt,
		completionAttemptSeq: run.completionAttemptSeq ?? 0,
		activeJobId: run.activeJobId
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
	return { ...run, ...executionFields(state ?? run) };
}

export async function getRunWithExecution(
	db: DatabaseReader,
	runId: Id<'runs'>
): Promise<ExecutionRun | null> {
	const run = await db.get('runs', runId);
	return run ? await withRunExecution(db, run) : null;
}

export async function migrateRunExecution(
	ctx: MutationCtx,
	run: Doc<'runs'>
): Promise<Id<'runExecutionStates'>> {
	const existing = await getRunExecutionState(ctx.db, run._id);
	const stateId =
		existing?._id ??
		(await ctx.db.insert('runExecutionStates', {
			runId: run._id,
			...executionFields(run)
		}));
	if (
		run.claimId !== undefined ||
		run.claimExpiresAt !== undefined ||
		run.completionAttemptSeq !== undefined ||
		run.activeJobId !== undefined
	) {
		await ctx.db.patch('runs', run._id, {
			claimId: undefined,
			claimExpiresAt: undefined,
			completionAttemptSeq: undefined,
			activeJobId: undefined
		});
	}
	return stateId;
}

export async function patchRunExecution(
	ctx: MutationCtx,
	runId: Id<'runs'>,
	patch: Partial<ExecutionFields>
): Promise<void> {
	const state = await getRunExecutionState(ctx.db, runId);
	if (state) {
		if (
			('claimId' in patch && state.claimId !== patch.claimId) ||
			('claimExpiresAt' in patch && state.claimExpiresAt !== patch.claimExpiresAt) ||
			('completionAttemptSeq' in patch &&
				state.completionAttemptSeq !== patch.completionAttemptSeq) ||
			('activeJobId' in patch && state.activeJobId !== patch.activeJobId)
		) {
			await ctx.db.patch('runExecutionStates', state._id, patch);
		}
		return;
	}
	const run = await ctx.db.get('runs', runId);
	if (!run) throw new Error('Run not found.');
	const stateId = await migrateRunExecution(ctx, run);
	await ctx.db.patch('runExecutionStates', stateId, patch);
}
