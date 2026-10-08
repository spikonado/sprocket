import type { Doc } from '@convex/_generated/dataModel';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';

export const AUTOMATIC_RECOVERY_SUBMISSION_PREFIX = 'automatic-recovery:';

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
