import { isRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import type { Infer } from 'convex/values';

/** Recognized by sprocket-agent (`provider.rs`) for clean run cancellation. */
export const RUN_CANCELLED_BY_USER = 'Run is cancelled.';

export const RUN_NO_LONGER_ACTIVE = 'Run is no longer active.';

export function assertRunAcceptsModelCompletion(status: Infer<typeof vRunStatus>): void {
	if (status === 'cancelled') {
		throw new Error(RUN_CANCELLED_BY_USER);
	}
	if (isRunFinalStatus(status)) {
		throw new Error(RUN_NO_LONGER_ACTIVE);
	}
}
