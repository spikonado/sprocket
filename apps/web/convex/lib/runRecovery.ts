import type { Doc } from '@convex/_generated/dataModel';
import type { DatabaseReader } from '@convex/_generated/server';
import { LEGACY_RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { getUiPreferences } from '@convex/lib/uiPreferences';

export const AUTOMATIC_RECOVERY_SUBMISSION_PREFIX = 'automatic-recovery:';

// Hosts scan for recoverable runs every 30 seconds with a 15 second request timeout.
export const AUTOMATIC_RECOVERY_GRACE_MS = 120_000;

export async function automaticAgentContinuationEnabled(
	db: DatabaseReader,
	userId: string
): Promise<boolean> {
	return (await getUiPreferences(db, userId))?.automaticAgentContinuation !== false;
}

export function isAutomaticallyRecoverableRun(
	run: Pick<
		Doc<'runs'>,
		| 'status'
		| 'failureKind'
		| 'lastError'
		| 'cancellationRequestedAt'
		| 'machineId'
		| 'pendingPrompt'
	>,
	machineId: string
): boolean {
	// A run that never began has no prompt part for a continuation to answer.
	return (
		isAbandonedRun(run) &&
		run.cancellationRequestedAt === undefined &&
		run.pendingPrompt === undefined &&
		run.machineId === machineId
	);
}

export function isAbandonedRun(
	run: Pick<Doc<'runs'>, 'status' | 'failureKind' | 'lastError'>
): boolean {
	return (
		run.status === 'failed' &&
		(run.failureKind === 'abandoned' || run.lastError === LEGACY_RUN_ABANDONED_BY_AGENT)
	);
}

export async function awaitsAutomaticRecovery(
	db: DatabaseReader,
	run: Doc<'runs'>
): Promise<boolean> {
	return (
		run.machineId !== undefined &&
		isAutomaticallyRecoverableRun(run, run.machineId) &&
		run.completedAt !== undefined &&
		run.completedAt + AUTOMATIC_RECOVERY_GRACE_MS > Date.now() &&
		(await automaticAgentContinuationEnabled(db, run.userId))
	);
}
