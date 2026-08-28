import { isRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import { ConvexError } from 'convex/values';
import type { Infer } from 'convex/values';

/** Recognized by sprocket-agent (`provider.rs`) for clean run cancellation. */
export const RUN_CANCELLED_BY_USER = 'Run is cancelled.';

export const RUN_NO_LONGER_ACTIVE = 'Run is no longer active.';

export const RUN_ABANDONED_BY_AGENT =
	'The local agent stopped responding before this run finished.';

/** Convex prefixes thrown Error messages with "Uncaught Error:" in production builds. */
const UNCAUGHT_ERROR_PREFIX = 'Uncaught Error: ';

// Sentinels are ConvexErrors so production keeps their text: the executor
// classifies runs by these exact messages.
export function assertRunAcceptsModelCompletion(status: Infer<typeof vRunStatus>): void {
	if (status === 'cancelled') {
		throw new ConvexError(RUN_CANCELLED_BY_USER);
	}
	if (isRunFinalStatus(status)) {
		throw new ConvexError(RUN_NO_LONGER_ACTIVE);
	}
}

function stripUncaughtPrefix(message: string): string {
	if (!message.startsWith(UNCAUGHT_ERROR_PREFIX)) return message;
	const stripped = message.slice(UNCAUGHT_ERROR_PREFIX.length);
	const newline = stripped.indexOf('\n');
	return newline === -1 ? stripped : stripped.slice(0, newline);
}

/**
 * Converts failures caught in executor-facing tool functions into ConvexErrors
 * so their text reaches the executor client and `job.error`; uncaught Errors
 * are masked to "[Request ID] Server Error" for both audiences in production.
 */
export function toAgentToolConvexError(error: Error): Error {
	if (error instanceof ConvexError) return error;
	const message = stripUncaughtPrefix(error.message) || error.name;
	return new ConvexError(message);
}
