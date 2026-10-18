import type { Doc } from '@convex/_generated/dataModel';
import type { DatabaseReader, MutationCtx } from '@convex/_generated/server';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { latestRunForThread } from '@convex/lib/runExecution';
import { getUiPreferences } from '@convex/lib/uiPreferences';

export const AUTOMATIC_RECOVERY_SUBMISSION_PREFIX = 'automatic-recovery:';

// How long the UI shows an update-interrupted run as restarting instead of failed.
export const RESTART_RECOVERY_WINDOW_MS = 5 * 60_000;

type RestartableRun = Pick<Doc<'runs'>, '_id' | 'threadId'>;

export async function markRunRestarting(
	ctx: MutationCtx,
	run: RestartableRun,
	restartingUntil: number | undefined
): Promise<void> {
	await ctx.db.patch('runs', run._id, { restartingUntil });

	if ((await latestRunForThread(ctx.db, run.threadId))?._id === run._id) {
		await ctx.db.patch('threadRecords', run.threadId, { restartingUntil });
	}
}

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
