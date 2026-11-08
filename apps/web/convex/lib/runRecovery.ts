import type { Doc } from '@convex/_generated/dataModel';
import type { DatabaseReader } from '@convex/_generated/server';
import { getUiPreferences } from '@convex/lib/uiPreferences';
import { runHasBegun } from '@convex/lib/runs';

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
	return (
		run.failureKind === 'abandoned' &&
		run.cancellationRequestedAt === undefined &&
		runHasBegun(run) &&
		run.machineId === machineId
	);
}
