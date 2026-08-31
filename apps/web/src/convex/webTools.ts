'use node';

import { ConvexError, v, type Infer } from 'convex/values';
import { z } from 'zod';
import { ContextDev } from '@context-dot-dev/convex';
import { ExaClient } from '@exalabs/convex-exa';
import { action, internalAction, type ActionCtx } from '@convex/_generated/server';
import { components, internal } from '@convex/_generated/api';
import {
	vScrapeUrlResult,
	vWebSearchResult,
	type ExecutorJobPayload
} from '@convex/lib/validators';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { NonRetryableError } from '@convex-dev/workpool';

const contextDev = new ContextDev(components.contextDev);
const exa = new ExaClient(components.exa);

const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
// Bounds the persisted executor-job result; Convex documents are capped at 1 MiB.
const SCRAPE_MARKDOWN_MAX_CHARS = 40_000;
const SCRAPE_TIMEOUT_MS = 60_000;
const SEARCH_RESULT_TEXT_MAX_CHARS = 2_000;
const SEARCH_TIMEOUT_MS = 30_000;

class WebToolTimeout extends Error {}

// Context.dev validates its scrape result against a bounded-depth JSON schema,
// so pages whose metadata nests deeper than the bound fail inside the component
// before any content reaches us (#208).
export function isUnparseablePageFailure(error: Error): boolean {
	return error.message.includes('ReturnsValidationError');
}

const UNPARSEABLE_PAGE_ERROR = 'The webpage is too complex and could not be parsed as Markdown.';
const UNCAUGHT_CONVEX_ERROR_PREFIX = 'Uncaught ConvexError: ';
const scrapeHttpErrorSchema = z.object({ status: z.number().int().min(400).max(599) });

export function scrapeHttpErrorStatus(error: Error): number | undefined {
	let message = error.message.split('\n', 1)[0] ?? '';
	while (message.startsWith(UNCAUGHT_CONVEX_ERROR_PREFIX)) {
		message = message.slice(UNCAUGHT_CONVEX_ERROR_PREFIX.length);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(message);
	} catch {
		return undefined;
	}
	const result = scrapeHttpErrorSchema.safeParse(payload);
	return result.success ? result.data.status : undefined;
}

async function withTimeout<T>(label: string, timeoutMs: number, promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new WebToolTimeout(`${label} timed out after ${timeoutMs}ms.`)),
			timeoutMs
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

type WebSearchJobArgs = {
	query: string;
	numResults?: number;
};

function scrapeUrlFromPayload(payload: ExecutorJobPayload): string {
	if (!('url' in payload)) return '';
	return payload.url;
}

function webSearchFromPayload(payload: ExecutorJobPayload): WebSearchJobArgs {
	if (!('query' in payload)) return { query: '' };
	const query = payload.query;
	if (!('numResults' in payload) || payload.numResults === undefined) {
		return { query };
	}
	return { query, numResults: payload.numResults };
}

async function runScrape(
	ctx: ActionCtx,
	urlValue: string
): Promise<Infer<typeof vScrapeUrlResult>> {
	let url: URL;
	try {
		url = new URL(urlValue.trim());
	} catch {
		throw new NonRetryableError(`Invalid URL: ${urlValue}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new NonRetryableError('Only http(s) URLs can be scraped.');
	}

	let response: Awaited<ReturnType<typeof contextDev.scrapeMarkdown>>;
	try {
		response = await withTimeout(
			'Context.dev scrape',
			SCRAPE_TIMEOUT_MS,
			contextDev.scrapeMarkdown(ctx, {
				params: {
					url: url.toString(),
					useMainContentOnly: true,
					timeoutMS: SCRAPE_TIMEOUT_MS
				}
			})
		);
	} catch (error) {
		if (error instanceof Error) {
			const status = scrapeHttpErrorStatus(error);
			if (status !== undefined) {
				const message = `This webpage returned a ${status} error.`;
				if (status === 408 || status === 429 || status >= 500) {
					throw new ConvexError(message);
				}
				throw new NonRetryableError(message, { cause: error });
			}
			if (isUnparseablePageFailure(error)) {
				throw new NonRetryableError(UNPARSEABLE_PAGE_ERROR, { cause: error });
			}
		}
		throw error;
	}

	const truncated = response.markdown.length > SCRAPE_MARKDOWN_MAX_CHARS;
	return {
		url: response.url,
		markdown: truncated ? response.markdown.slice(0, SCRAPE_MARKDOWN_MAX_CHARS) : response.markdown,
		truncated
	};
}

async function runSearch(
	ctx: ActionCtx,
	queryValue: string,
	numResultsValue: number | undefined
): Promise<Infer<typeof vWebSearchResult>> {
	const query = queryValue.trim();
	if (!query) {
		throw new NonRetryableError('Search query cannot be empty.');
	}
	const requested =
		numResultsValue !== undefined && Number.isFinite(numResultsValue)
			? Math.floor(numResultsValue)
			: DEFAULT_SEARCH_RESULTS;
	const numResults = Math.min(Math.max(requested, 1), MAX_SEARCH_RESULTS);

	const response = await withTimeout(
		'Exa search',
		SEARCH_TIMEOUT_MS,
		exa.search(ctx, {
			query,
			type: 'auto',
			numResults,
			contents: { text: { maxCharacters: SEARCH_RESULT_TEXT_MAX_CHARS } }
		})
	);

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

/** Retired direct scrape action. Kept so older agents get an update message. */
export const scrapeUrl = action({
	args: {
		url: v.string(),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

/** Retired direct search action. Kept so older agents get an update message. */
export const webSearch = action({
	args: {
		query: v.string(),
		numResults: v.optional(v.number()),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

const executeArgs = {
	jobId: v.id('executorJobs'),
	runId: v.id('runs'),
	claimId: v.string()
};

export const executeScrapeUrl = internalAction({
	args: executeArgs,
	returns: vScrapeUrlResult,
	handler: async (ctx, args): Promise<Infer<typeof vScrapeUrlResult>> => {
		const job = await ctx.runQuery(internal.webToolPool.getWebToolJob, args);
		if (!job || job.kind !== 'scrape_url') {
			throw new NonRetryableError('Run is no longer active.');
		}
		return await runScrape(ctx, scrapeUrlFromPayload(job.payload));
	}
});

export const executeWebSearch = internalAction({
	args: executeArgs,
	returns: vWebSearchResult,
	handler: async (ctx, args): Promise<Infer<typeof vWebSearchResult>> => {
		const job = await ctx.runQuery(internal.webToolPool.getWebToolJob, args);
		if (!job || job.kind !== 'web_search') {
			throw new NonRetryableError('Run is no longer active.');
		}
		const search = webSearchFromPayload(job.payload);
		return await runSearch(ctx, search.query, search.numResults);
	}
});
