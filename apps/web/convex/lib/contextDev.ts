import { z } from 'zod';
import { APIConnectionTimeoutError, APIError, ContextDev } from 'context.dev';
import type { WebScrapeParams } from 'context.dev/resources/web';
import { env } from '@convex/_generated/server';
import { retryAfterHeaderMs, retryRateLimited } from '@convex/lib/providerRetry';

export const CONTEXT_DEV_CREDITS_EXHAUSTED = 'context.dev credits are exhausted.';

/** context.dev's own deadline for one scrape attempt. */
const SCRAPE_TIMEOUT_MS = 60_000;

/** Long enough to reuse pages that sibling subagents re-read, short enough for distributor stock. */
export const SCRAPE_CACHE_MAX_AGE_MS = 30 * 60 * 1_000;

/** Ends retries before the agent stops waiting for the scrape. */
const SCRAPE_RETRY_BUDGET_MS = 8 * 60_000;

/** The SDK must outwait the API deadline so the API reports the timeout. */
const SDK_TIMEOUT_MARGIN_MS = 10_000;

const errorBodySchema = z.object({
	error_code: z.string().optional(),
	code: z.string().optional(),
	message: z.string().optional()
});

function contextDevClient(): ContextDev {
	const apiKey = env.CONTEXT_DEV_API_KEY?.trim();

	if (!apiKey) throw new Error('CONTEXT_DEV_API_KEY is not configured.');

	return new ContextDev({ apiKey, maxRetries: 0 });
}

function contextDevRetryAfterMs(error: Error): number | undefined {
	return error instanceof APIError && error.status === 429
		? retryAfterHeaderMs(error.headers?.get('retry-after'))
		: undefined;
}

function contextDevFailure(error: Error): Error {
	if (error instanceof APIConnectionTimeoutError) {
		return new Error('context.dev scrape timed out.', { cause: error });
	}

	if (!(error instanceof APIError) || error.status === undefined) return error;

	const body = errorBodySchema.safeParse(error.error).data;
	const code = body?.error_code ?? body?.code;

	if (error.status === 401 && code === 'USAGE_EXCEEDED') {
		return new Error(CONTEXT_DEV_CREDITS_EXHAUSTED, { cause: error });
	}

	if (error.status === 408) return new Error('context.dev scrape timed out.', { cause: error });

	const detail = body?.message?.trim();
	const suffix = [code, detail].filter(Boolean).join(': ');

	return new Error(
		suffix
			? `context.dev scrape failed (${error.status}): ${suffix}`
			: `context.dev scrape failed (${error.status}).`,
		{ cause: error }
	);
}

function scrapeParams(url: string, rawDocument: boolean): WebScrapeParams {
	return rawDocument
		? { url, formats: { bytes: true } }
		: {
				url,
				formats: { markdown: true },
				markdownParams: { includeImages: true },
				sharedParams: { mainContentOnly: true }
			};
}

/** Returns context.dev's unread response so large pages and documents stream to the caller. */
export async function requestContextDevScrape(
	url: string,
	rawDocument: boolean,
	shouldContinue: () => Promise<boolean>
): Promise<Response> {
	const params = scrapeParams(url, rawDocument);

	return await retryRateLimited({
		deadline: Date.now() + SCRAPE_RETRY_BUDGET_MS,
		maxAttemptMs: SCRAPE_TIMEOUT_MS,
		attempt: async (timeoutMs) =>
			await contextDevClient()
				.web.scrape(
					{
						...params,
						maxAgeMs: SCRAPE_CACHE_MAX_AGE_MS,
						timeoutOpts: { milliseconds: timeoutMs, behavior: 'fail' }
					},
					{ timeout: timeoutMs + SDK_TIMEOUT_MARGIN_MS }
				)
				.asResponse(),
		rateLimitWaitMs: contextDevRetryAfterMs,
		finalError: contextDevFailure,
		shouldContinue
	});
}
