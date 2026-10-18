import type { Doc } from '@convex/_generated/dataModel';
import type { DatabaseReader } from '@convex/_generated/server';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { getUiPreferences } from '@convex/lib/uiPreferences';

export const AUTOMATIC_RECOVERY_SUBMISSION_PREFIX = 'automatic-recovery:';

export async function automaticAgentContinuationEnabled(
	db: DatabaseReader,
	userId: string
): Promise<boolean> {
	return (await getUiPreferences(db, userId))?.automaticAgentContinuation !== false;
}

export function isAutomaticallyRecoverableRun(
	run: Pick<Doc<'runs'>, 'status' | 'lastError' | 'cancellationRequestedAt' | 'machineId'>,
	machineId: string
): boolean {
	return (
		run.status === 'failed' &&
		run.lastError === RUN_ABANDONED_BY_AGENT &&
		run.cancellationRequestedAt === undefined &&
		run.machineId === machineId
	);
}
