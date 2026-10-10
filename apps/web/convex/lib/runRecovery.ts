import type { Doc } from '@convex/_generated/dataModel';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { hasPendingUsageLimitResume } from '@convex/lib/providerUsageLimit';

export const AUTOMATIC_RECOVERY_SUBMISSION_PREFIX = 'automatic-recovery:';

export function isAutomaticallyRecoverableRun(
	run: Pick<
		Doc<'runs'>,
		| 'status'
		| 'lastError'
		| 'cancellationRequestedAt'
		| 'machineId'
		| 'completionProvider'
		| 'usageLimit'
		| 'taskDeadlineAt'
	>,
	machineId: string
): boolean {
	if (run.taskDeadlineAt !== undefined && run.taskDeadlineAt <= Date.now()) return false;

	if (run.usageLimit?.retryAt !== undefined) {
		return (
			run.machineId === machineId &&
			hasPendingUsageLimitResume(run) &&
			run.usageLimit.retryAt <= Date.now()
		);
	}

	return (
		run.status === 'failed' &&
		run.lastError === RUN_ABANDONED_BY_AGENT &&
		run.cancellationRequestedAt === undefined &&
		run.machineId === machineId
	);
}
