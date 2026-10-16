'use node';

import { NonRetryableError } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { internalAction } from '@convex/_generated/server';
import {
	FIRECRAWL_PARSE_TIMEOUT_MS,
	HOSTED_PARSE_MAX_INPUT_BYTES,
	firecrawlParseOptions,
	parseFirecrawlParseDocument,
	readBoundedResponseBytes,
	shortHostedParseError
} from '@convex/lib/hostedParse';
import { firecrawlClient, firecrawlFailure, firecrawlRetryAfterMs } from '@convex/lib/firecrawl';
import { retryRateLimited } from '@convex/lib/providerRetry';

/** Leaves room under the 10-minute action limit and the agent's 10-minute wait. */
const HOSTED_PARSE_RETRY_BUDGET_MS = 8 * 60_000;

const executeArgs = {
	requestId: v.id('hostedParseRequests'),
	jobId: v.id('executorJobs'),
	runId: v.id('runs'),
	claimId: v.string()
};

const executeReturns = v.object({
	skipped: v.optional(v.boolean()),
	resultStorageId: v.optional(v.id('_storage'))
});

export const executeHostedParse = internalAction({
	args: executeArgs,
	returns: executeReturns,
	handler: async (ctx, args) => {
		const deadline = Date.now() + HOSTED_PARSE_RETRY_BUDGET_MS;
		const work = await ctx.runQuery(internal.hostedParse.getParseWork, args);

		if (!work) {
			return { skipped: true };
		}

		const pages = work.pages === true;
		const inputUrl = await ctx.storage.getUrl(work.inputStorageId);

		if (!inputUrl) {
			throw new NonRetryableError('Uploaded file is unavailable.');
		}

		let inputBytes: Uint8Array;

		try {
			inputBytes = await fetchStorageBytes(inputUrl);
		} catch (error) {
			throw new NonRetryableError(
				error instanceof Error ? error.message : 'Failed to read the uploaded file.'
			);
		}

		const document = await retryRateLimited({
			deadline,
			maxAttemptMs: FIRECRAWL_PARSE_TIMEOUT_MS,
			attempt: async (timeoutMs) =>
				await firecrawlClient(timeoutMs).parse(
					{
						data: inputBytes,
						filename: work.filename,
						contentType: mediaTypeForFilename(work.filename)
					},
					{ ...firecrawlParseOptions(pages), timeout: timeoutMs }
				),
			retryAfterMs: firecrawlRetryAfterMs,
			failure: (error) =>
				new NonRetryableError(
					shortHostedParseError(firecrawlFailure('Firecrawl parse', error).message)
				)
		});

		const parsed = parseFirecrawlParseDocument(document, pages);

		if ('error' in parsed) {
			throw new NonRetryableError(shortHostedParseError(parsed.error));
		}

		const resultStorageId = await ctx.storage.store(
			'pages' in parsed
				? new Blob([JSON.stringify({ pages: parsed.pages })], { type: 'application/json' })
				: new Blob([parsed.markdown], { type: 'text/markdown; charset=utf-8' })
		);

		return { resultStorageId };
	}
});

function mediaTypeForFilename(filename: string): string {
	return filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
}

async function fetchStorageBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });

	if (!response.ok) {
		throw new Error('Uploaded file is unavailable.');
	}

	return await readBoundedResponseBytes(response, HOSTED_PARSE_MAX_INPUT_BYTES);
}
