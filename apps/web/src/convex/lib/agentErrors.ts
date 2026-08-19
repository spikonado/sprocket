import { isRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import { COMPLETION_STREAM_SUPERSEDED } from '@convex/lib/completionStream';
import { ConvexError } from 'convex/values';
import type { Infer } from 'convex/values';

/** Recognized by sprocket-agent (`provider.rs`) for clean run cancellation. */
export const RUN_CANCELLED_BY_USER = 'Run is cancelled.';

export const RUN_NO_LONGER_ACTIVE = 'Run is no longer active.';

/** Convex prefixes thrown Error messages with "Uncaught Error:" in production builds. */
const UNCAUGHT_ERROR_PREFIX = 'Uncaught Error: ';

export function assertRunAcceptsModelCompletion(status: Infer<typeof vRunStatus>): void {
	if (status === 'cancelled') {
		throw new Error(RUN_CANCELLED_BY_USER);
	}
	if (isRunFinalStatus(status)) {
		throw new Error(RUN_NO_LONGER_ACTIVE);
	}
}

function stripUncaughtPrefix(message: string): string {
	return message.startsWith(UNCAUGHT_ERROR_PREFIX)
		? message.slice(UNCAUGHT_ERROR_PREFIX.length)
		: message;
}

function statusCodeFromError(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const value = error as Record<string, unknown>;
	if (typeof value.statusCode === 'number') return value.statusCode;
	if (typeof value.status === 'number') return value.status;
	return statusCodeFromError(value.cause);
}

function quotaMessageFromError(error: unknown): string | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const value = error as Record<string, unknown>;
	if (typeof value.responseBody === 'string') {
		try {
			const body: unknown = JSON.parse(value.responseBody);
			if (body && typeof body === 'object' && !Array.isArray(body)) {
				const providerError = (body as Record<string, unknown>).error;
				if (providerError && typeof providerError === 'object' && !Array.isArray(providerError)) {
					const message = (providerError as Record<string, unknown>).message;
					if (typeof message === 'string') return message;
				}
			}
		} catch {
			// The provider body is only parsed for a friendlier message.
		}
	}
	return quotaMessageFromError(value.cause);
}

function looksLikeProviderBillingError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const value = error as Record<string, unknown>;
	if (typeof value.message === 'string') {
		const message = value.message.toLowerCase();
		if (
			message.includes('insufficient_quota') ||
			message.includes('insufficient quota') ||
			message.includes('billing') ||
			message.includes('credit balance') ||
			message.includes('exceeded your current quota')
		) {
			return true;
		}
	}
	return looksLikeProviderBillingError(value.cause);
}

/**
 * Turns failures thrown by the model layer into ConvexErrors whose messages stay
 * readable in production; uncaught Errors are masked to "[Request ID] Server
 * Error" for both the executor client and `run.lastError` in the UI.
 *
 * Control-flow errors (cancellation, lease loss, stream supersede) pass through
 * unchanged. They must stay plain Errors so callers can detect them by message.
 */
export function toModelCompletionConvexError(
	error: unknown,
	context: { modelId: string; serviceTier: string }
): Error {
	if (!(error instanceof Error)) {
		return new ConvexError(`The model provider failed: ${String(error)}`);
	}
	if (error instanceof ConvexError) return error;
	const message = stripUncaughtPrefix(error.message);
	if (
		message.includes(RUN_CANCELLED_BY_USER) ||
		message.includes(RUN_NO_LONGER_ACTIVE) ||
		message.includes(COMPLETION_STREAM_SUPERSEDED)
	) {
		return error;
	}
	const statusCode = statusCodeFromError(error);
	if (statusCode === 401 || statusCode === 403 || looksLikeProviderBillingError(error)) {
		const providerMessage = quotaMessageFromError(error);
		return new ConvexError(
			providerMessage
				? `The model provider rejected the request: ${providerMessage}`
				: 'The model provider rejected the request. Check the provider billing, credits, and API key configuration.'
		);
	}
	if (statusCode !== undefined) {
		const qualifier = statusCode >= 500 ? 'a server error' : 'an error';
		return new ConvexError(
			`The model provider returned ${qualifier} (HTTP ${statusCode}) while running ${context.modelId} on the ${context.serviceTier} tier: ${message}`
		);
	}
	return new ConvexError(`The model provider failed: ${message}`);
}
