import type { Doc, Id } from '@convex/_generated/dataModel';
import { ConvexError } from 'convex/values';

export const RUN_CANNOT_CONTINUE = 'This run cannot continue.';

export const ONLY_LATEST_RUN_CAN_CONTINUE = 'Only the latest run can continue.';

export function isContinuableRunStatus(
	status: Doc<'runs'>['status'],
	recordsPrompt: boolean
): status is 'completed' | 'failed' | 'cancelled' {
	return status === 'failed' || status === 'cancelled' || (status === 'completed' && recordsPrompt);
}

export function assertContinuableParent<
	T extends Pick<Doc<'runs'>, '_id' | 'status' | 'pendingPrompt'>
>(latest: T | null, parentRunId: Id<'runs'>, recordsPrompt: boolean): T {
	if (!latest || latest._id !== parentRunId) {
		throw new ConvexError(ONLY_LATEST_RUN_CAN_CONTINUE);
	}

	// The client restores an unsent prompt to the composer, so continuing must not send it too.
	if (
		!isContinuableRunStatus(latest.status, recordsPrompt) ||
		(!recordsPrompt && latest.pendingPrompt !== undefined)
	) {
		throw new ConvexError(RUN_CANNOT_CONTINUE);
	}

	return latest;
}
