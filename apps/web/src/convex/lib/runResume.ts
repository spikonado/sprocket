import type { Doc, Id } from '@convex/_generated/dataModel';
import { ConvexError } from 'convex/values';

export const RUN_CANNOT_CONTINUE = 'This run cannot continue.';
export const ONLY_LATEST_RUN_CAN_CONTINUE = 'Only the latest run can continue.';

export function isContinuableRunStatus(
	status: Doc<'runs'>['status']
): status is 'failed' | 'cancelled' {
	return status === 'failed' || status === 'cancelled';
}

export function assertContinuableParent<
	T extends { _id: Id<'runs'>; status: Doc<'runs'>['status'] }
>(latest: T | null, parentRunId: Id<'runs'>): T {
	if (!latest || latest._id !== parentRunId) {
		throw new ConvexError(ONLY_LATEST_RUN_CAN_CONTINUE);
	}
	if (!isContinuableRunStatus(latest.status)) {
		throw new ConvexError(RUN_CANNOT_CONTINUE);
	}
	return latest;
}
