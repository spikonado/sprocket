import { isRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import { COMPLETION_STREAM_SUPERSEDED } from '@convex/lib/completionStream';
import { ConvexError } from 'convex/values';
import type { Infer } from 'convex/values';

/** Recognized by sprocket-agent (`provider.rs`) for clean run cancellation. */
export const RUN_CANCELLED_BY_USER = 'Run is cancelled.';

export const RUN_NO_LONGER_ACTIVE = 'Run is no longer active.';

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

/** Follows `cause`, then the AI SDK RetryError's `lastError`. */
function errorChain(error: unknown): Record<string, unknown>[] {
	const chain: Record<string, unknown>[] = [];
	let current: unknown = error;
	while (current && typeof current === 'object') {
		const value = current as Record<string, unknown>;
		if (chain.includes(value)) break;
		chain.push(value);
		current = value.cause ?? value.lastError;
	}
	return chain;
}

function stripUncaughtPrefix(message: string): string {
	if (!message.startsWith(UNCAUGHT_ERROR_PREFIX)) return message;
	const stripped = message.slice(UNCAUGHT_ERROR_PREFIX.length);
	const newline = stripped.indexOf('\n');
	return newline === -1 ? stripped : stripped.slice(0, newline);
}

function providerErrorFromBody(body: unknown): { code?: string; message?: string } | undefined {
	if (typeof body !== 'string') return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
		const providerError = (parsed as Record<string, unknown>).error;
		if (!providerError || typeof providerError !== 'object' || Array.isArray(providerError)) {
			return undefined;
		}
		const record = providerError as Record<string, unknown>;
		const code = record.code ?? record.type;
		return {
			...(typeof code === 'string' ? { code } : {}),
			...(typeof record.message === 'string' ? { message: record.message } : {})
		};
	} catch {
		// The provider body is only parsed for a friendlier message.
		return undefined;
	}
}

function statusCodeFromError(error: unknown): number | undefined {
	for (const candidate of errorChain(error)) {
		if (typeof candidate.statusCode === 'number') return candidate.statusCode;
		if (typeof candidate.status === 'number') return candidate.status;
	}
	return undefined;
}

function providerMessageFromError(error: unknown): string | undefined {
	for (const candidate of errorChain(error)) {
		const message = providerErrorFromBody(candidate.responseBody)?.message;
		if (message) return message;
		const data = candidate.data;
		if (data && typeof data === 'object' && !Array.isArray(data)) {
			const providerError = (data as Record<string, unknown>).error;
			if (providerError && typeof providerError === 'object' && !Array.isArray(providerError)) {
				const dataMessage = (providerError as Record<string, unknown>).message;
				if (typeof dataMessage === 'string') return dataMessage;
			}
		}
	}
	return undefined;
}

function looksLikeProviderBillingError(error: unknown): boolean {
	for (const candidate of errorChain(error)) {
		if (providerErrorFromBody(candidate.responseBody)?.code === 'insufficient_quota') {
			return true;
		}
		const data = candidate.data;
		if (data && typeof data === 'object' && !Array.isArray(data)) {
			const providerError = (data as Record<string, unknown>).error;
			if (
				providerError &&
				typeof providerError === 'object' &&
				!Array.isArray(providerError) &&
				(providerError as Record<string, unknown>).code === 'insufficient_quota'
			) {
				return true;
			}
		}
		if (typeof candidate.message !== 'string') continue;
		const message = candidate.message.toLowerCase();
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
	return false;
}

function innermostMessage(error: unknown): string | undefined {
	const chain = errorChain(error);
	for (let index = chain.length - 1; index >= 0; index -= 1) {
		const candidate = chain[index];
		if (candidate instanceof Error && candidate.message) return candidate.message;
	}
	return undefined;
}

/**
 * Turns failures thrown by the model layer into ConvexErrors whose messages stay
 * readable in production; uncaught Errors are masked to "[Request ID] Server
 * Error" for both the executor client and `run.lastError` in the UI.
 *
 * Control-flow errors (cancellation, lease loss, stream supersede) pass through
 * unchanged. They must stay plain Errors so callers can detect them by message.
 */
export function toModelCompletionConvexError(error: unknown, modelId: string): Error {
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
	const detail =
		providerMessageFromError(error) ?? stripUncaughtPrefix(innermostMessage(error) ?? message);
	const statusCode = statusCodeFromError(error);
	if (looksLikeProviderBillingError(error)) {
		return new ConvexError(`The model provider rejected the request: ${detail}`);
	}
	// Provider bodies for auth failures can echo the API key; keep them server-side.
	if (statusCode === 401 || statusCode === 403) {
		return new ConvexError(
			'The model provider rejected the API key. Check the provider API key configuration.'
		);
	}
	if (statusCode !== undefined) {
		const qualifier = statusCode >= 500 ? 'a server error' : 'an error';
		return new ConvexError(
			`The model provider returned ${qualifier} (HTTP ${statusCode}) while running ${modelId}: ${detail}`
		);
	}
	return new ConvexError(`The model provider failed: ${detail}`);
}
