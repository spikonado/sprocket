import { isRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import agentErrorMessages from '@convex/lib/agentErrorCodes.json';
import { ConvexError } from 'convex/values';
import { z } from 'zod';
import type { Infer } from 'convex/values';

export type AgentErrorCode = keyof typeof agentErrorMessages;

export function agentError(code: AgentErrorCode): ConvexError<string> {
	return new ConvexError(agentErrorMessages[code]);
}

export const RUN_NO_LONGER_ACTIVE = agentErrorMessages.RUN_NO_LONGER_ACTIVE;

export const TOOL_NO_LONGER_SUPPORTED = 'This tool is no longer supported.';

export const PAYMENTS_MOVED_TO_AGENTCARD =
	'Payments moved to Agentcard. Update Sprocket to buy things.';

export const RUN_ABANDONED_BY_MACHINE = 'The machine stopped responding before this run finished.';

export function assertRunAcceptsModelCompletion(run: {
	status: Infer<typeof vRunStatus>;
	cancellationRequestedAt?: number;
}): void {
	if (run.cancellationRequestedAt !== undefined || run.status === 'cancelled') {
		throw agentError('RUN_CANCELLED');
	}

	if (isRunFinalStatus(run.status)) {
		throw agentError('RUN_NO_LONGER_ACTIVE');
	}
}

function stripUncaughtPrefix(message: string): string {
	const stripped = message.replace(/^(?:Uncaught (?:Convex)?Error: )+/, '');

	if (stripped === message) return message;
	const newline = stripped.indexOf('\n');

	return newline === -1 ? stripped : stripped.slice(0, newline);
}

/**
 * Converts failures caught in executor-facing tool functions into ConvexErrors
 * so their text reaches the executor client and `job.error`; uncaught Errors
 * are masked to "[Request ID] Server Error" for both audiences in production.
 */
export function toAgentToolConvexError(error: Error): Error {
	if (error instanceof ConvexError) {
		const data = z.string().safeParse(error.data);

		if (!data.success) return error;
		const message = stripUncaughtPrefix(data.data);

		return message === data.data ? error : new ConvexError(message);
	}

	const message = stripUncaughtPrefix(error.message) || error.name;

	return new ConvexError(message);
}
