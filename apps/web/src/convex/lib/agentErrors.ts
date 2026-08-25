import { isRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import { COMPLETION_STREAM_SUPERSEDED } from '@convex/lib/completionStream';
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	isJsonValue,
	type JsonValue
} from '@convex/lib/json';
import { ConvexError } from 'convex/values';
import type { Infer } from 'convex/values';
import { z } from 'zod';

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

const errorCarrierSchema = z
	.object({
		cause: z.any().optional(),
		lastError: z.any().optional(),
		statusCode: z.unknown().optional(),
		status: z.unknown().optional(),
		response: z.unknown().optional(),
		responseBody: z.unknown().optional(),
		data: z.unknown().optional(),
		message: z.unknown().optional()
	})
	.loose();

type ErrorCarrier = z.infer<typeof errorCarrierSchema>;

function isErrorCarrier(value: ErrorCarrier['cause']): value is ErrorCarrier {
	return errorCarrierSchema.safeParse(value).success;
}

/** Follows `cause`, then the AI SDK RetryError's `lastError`. */
function errorChain(error: Error): Array<Error | ErrorCarrier> {
	const chain: Array<Error | ErrorCarrier> = [];
	let current: Error | ErrorCarrier | undefined = error;
	while (current !== undefined) {
		if (chain.includes(current)) break;
		chain.push(current);
		const parsed = errorCarrierSchema.safeParse(current);
		if (!parsed.success) break;
		const next = parsed.data.cause ?? parsed.data.lastError;
		current = next instanceof Error || isErrorCarrier(next) ? next : undefined;
	}
	return chain;
}

function carrierFields(value: Error | ErrorCarrier): ErrorCarrier {
	const parsed = errorCarrierSchema.safeParse(value);
	return parsed.success ? parsed.data : {};
}

function stripUncaughtPrefix(message: string): string {
	if (!message.startsWith(UNCAUGHT_ERROR_PREFIX)) return message;
	const stripped = message.slice(UNCAUGHT_ERROR_PREFIX.length);
	const newline = stripped.indexOf('\n');
	return newline === -1 ? stripped : stripped.slice(0, newline);
}

type ProviderErrorFields = {
	code?: string;
	message?: string;
};

function readJsonString<T>(value: T): string | undefined {
	return isJsonValue(value) && isJsonString(value) ? value : undefined;
}

function readJsonNumber<T>(value: T): number | undefined {
	return isJsonValue(value) && isJsonNumber(value) ? value : undefined;
}

function providerErrorFromData<T>(data: T): ProviderErrorFields | undefined {
	if (!isJsonValue(data)) return undefined;
	return providerErrorFromObject(data);
}

function providerErrorFromObject(data: JsonValue): ProviderErrorFields | undefined {
	if (!isJsonObject(data) || !isJsonObject(data.error)) return undefined;
	const code = data.error.code ?? data.error.type;
	const fields: ProviderErrorFields = {};
	if (isJsonString(code)) fields.code = code;
	if (isJsonString(data.error.message)) fields.message = data.error.message;
	return fields;
}

function providerErrorFromBody<T>(body: T): ProviderErrorFields | undefined {
	if (!isJsonString(body)) return undefined;
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(body);
	} catch {
		// The provider body is only parsed for a friendlier message.
		return undefined;
	}
	return providerErrorFromData(parsed);
}

function statusCodeFromError(error: Error): number | undefined {
	for (const candidate of errorChain(error)) {
		const fields = carrierFields(candidate);
		const statusCode = readJsonNumber(fields.statusCode);
		if (statusCode !== undefined) return statusCode;
		const status = readJsonNumber(fields.status);
		if (status !== undefined) return status;
	}
	return undefined;
}

function providerMessageFromError(error: Error): string | undefined {
	for (const candidate of errorChain(error)) {
		const fields = carrierFields(candidate);
		const bodyMessage = providerErrorFromBody(fields.responseBody)?.message;
		if (bodyMessage) return bodyMessage;
		const dataMessage = providerErrorFromData(fields.data)?.message;
		if (dataMessage) return dataMessage;
	}
	return undefined;
}

function looksLikeProviderBillingError(error: Error): boolean {
	for (const candidate of errorChain(error)) {
		const fields = carrierFields(candidate);
		if (providerErrorFromBody(fields.responseBody)?.code === 'insufficient_quota') {
			return true;
		}
		if (providerErrorFromData(fields.data)?.code === 'insufficient_quota') {
			return true;
		}
		const messageText = readJsonString(fields.message);
		if (messageText === undefined) continue;
		const message = messageText.toLowerCase();
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

function innermostMessage(error: Error): string | undefined {
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
export function toModelCompletionConvexError(error: Error, modelId: string): Error {
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
