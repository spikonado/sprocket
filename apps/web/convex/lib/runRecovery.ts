import type { Doc } from '@convex/_generated/dataModel';
import type { DatabaseReader } from '@convex/_generated/server';
import { getUiPreferences } from '@convex/lib/uiPreferences';

/** Released hosts mark automatic recovery only through this submission-ID prefix. */
export const LEGACY_AUTOMATIC_RECOVERY_SUBMISSION_PREFIX = 'automatic-recovery:';

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
