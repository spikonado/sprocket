import type { Doc } from '@convex/_generated/dataModel';
import type { DatabaseReader } from '@convex/_generated/server';
import { getUiPreferences } from '@convex/lib/uiPreferences';

export const AUTOMATIC_RECOVERY_SUBMISSION_PREFIX = 'automatic-recovery:';

export async function automaticAgentContinuationEnabled(
	db: DatabaseReader,
	userId: string
): Promise<boolean> {
	return (await getUiPreferences(db, userId))?.automaticAgentContinuation !== false;
}

export function isAutomaticallyRecoverableRun(
	run: Pick<Doc<'runs'>, 'failureKind' | 'cancellationRequestedAt' | 'machineId' | 'pendingPrompt'>,
	machineId: string
): boolean {
	// A run that never began has no prompt part for a continuation to answer.
	return (
		run.failureKind === 'abandoned' &&
		run.cancellationRequestedAt === undefined &&
		run.pendingPrompt === undefined &&
		run.machineId === machineId
	);
}

/** True while the host can still continue this abandoned run. No clock: the
 * host journal and a later replacement run are what end the wait. */
export async function isAwaitingHostRecovery(
	db: DatabaseReader,
	run: Doc<'runs'> | null
): Promise<boolean> {
	if (!run?.machineId || !isAutomaticallyRecoverableRun(run, run.machineId)) {
		return false;
	}

	const latest = await db
		.query('runs')
		.withIndex('by_threadId', (q) => q.eq('threadId', run.threadId))
		.order('desc')
		.first();

	return latest?._id === run._id && (await automaticAgentContinuationEnabled(db, run.userId));
}
