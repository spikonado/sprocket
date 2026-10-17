'use node';

import { Firecrawl, SdkError } from 'firecrawl';
import { env } from '@convex/_generated/server';

export const FIRECRAWL_CREDITS_EXHAUSTED = 'Firecrawl credits are exhausted.';

/** Throws when the key is missing so callers never fall back to the keyless tier. */
export function firecrawlClient(timeoutMs: number): Firecrawl {
	const apiKey = env.FIRECRAWL_API_KEY?.trim();

	if (!apiKey) throw new Error('FIRECRAWL_API_KEY is not configured.');

	// The SDK counts attempts, so 1 disables its own 502 retries.
	return new Firecrawl({ apiKey, maxRetries: 1, timeoutMs });
}

export function firecrawlRetryAfterMs(error: Error): number | undefined {
	return error instanceof SdkError && error.status === 429 ? 0 : undefined;
}

/** `action` names the call, as in "Firecrawl parse failed (500): ...". */
export function firecrawlFailure(action: string, error: Error): Error {
	if (!(error instanceof SdkError)) return error;

	if (error.status === 402) return new Error(FIRECRAWL_CREDITS_EXHAUSTED, { cause: error });

	const detail = error.message.trim();

	if (error.status === 400 && detail) return new Error(detail, { cause: error });

	const status = error.status === undefined ? '' : ` (${error.status})`;

	return new Error(detail ? `${action} failed${status}: ${detail}` : `${action} failed${status}.`, {
		cause: error
	});
}
