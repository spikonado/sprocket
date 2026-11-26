'use node';

import { v, type Infer } from 'convex/values';
import { ExaClient } from '@exalabs/convex-exa';
import { internalAction, type ActionCtx } from '@convex/_generated/server';
import { components, internal } from '@convex/_generated/api';
import { vWebSearchResult, type ExecutorJobPayload } from '@convex/lib/validators';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { NonRetryableError } from '@convex-dev/workpool';

const exa = new ExaClient(components.exa);

const SEARCH_RESULT_TEXT_MAX_CHARS = 2_000;

const SEARCH_TIMEOUT_MS = 30_000;

class WebProviderTimeout extends Error {}

function isRetryableHttpStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

const EXA_SEARCH_HTTP_ERROR = /Exa \/search failed \((\d{3})\):\s*([^\r\n]*)/;

export function classifyExaSearchFailure(error: Error): Error {
	if (error instanceof WebProviderTimeout) {
		return error;
	}

	const statusMatch = EXA_SEARCH_HTTP_ERROR.exec(error.message);

	if (statusMatch) {
		const status = Number(statusMatch[1]);

		if (!isRetryableHttpStatus(status)) {
			const detail = statusMatch[2]?.trim();

			const message = detail
				? `Exa search failed (${status}): ${detail}`
				: `Exa search failed (${status}).`;

			return new NonRetryableError(message, { cause: error });
		}
	}

	if (error.message.includes('Missing EXA_API_KEY')) {
		return new NonRetryableError('EXA_API_KEY is not configured.', { cause: error });
	}

	return error;
}

async function withTimeout<T>(label: string, timeoutMs: number, promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new WebProviderTimeout(`${label} timed out after ${timeoutMs}ms.`)),
			timeoutMs
		);
	});

	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function runSearch(
	ctx: ActionCtx,
	queryValue: string
): Promise<Infer<typeof vWebSearchResult>> {
	const query = queryValue.trim();

	if (!query) {
		throw new NonRetryableError('Search query cannot be empty.');
	}

	let response: Awaited<ReturnType<typeof exa.search>>;

	try {
		response = await withTimeout(
			'Exa search',
			SEARCH_TIMEOUT_MS,
			exa.search(ctx, {
				query,
				type: 'auto',
				contents: { text: { maxCharacters: SEARCH_RESULT_TEXT_MAX_CHARS } }
			})
		);
	} catch (error) {
		if (!(error instanceof Error)) {
			throw new Error('Exa search failed with an invalid error.', { cause: error });
		}

		throw classifyExaSearchFailure(error);
	}

	return {
		results: response.results.flatMap((result) => {
			if (!result.url) {
				return [];
			}

			const item: Infer<typeof vWebSearchResult>['results'][number] = {
				url: result.url
			};

			if (result.title) item.title = result.title;

			if (result.publishedDate) item.publishedDate = result.publishedDate;

			if (result.author) item.author = result.author;

			if (result.text) item.text = result.text;

			return [item];
		})
	};
}

const executeArgs = {
	jobId: v.id('executorJobs'),
	runId: v.id('runs'),
	claimId: v.string()
};

function webSearchQuery(payload: ExecutorJobPayload): string {
	return 'query' in payload && payload.query !== undefined ? payload.query : '';
}

export const executeWebSearch = internalAction({
	args: executeArgs,
	returns: vWebSearchResult,
	handler: async (ctx, args): Promise<Infer<typeof vWebSearchResult>> => {
		const job = await ctx.runMutation(internal.webSearchPool.getWebSearchJob, args);

		if (!job || job.kind !== 'web_search') {
			throw new NonRetryableError(RUN_NO_LONGER_ACTIVE);
		}

		return await runSearch(ctx, webSearchQuery(job.payload));
	}
});
