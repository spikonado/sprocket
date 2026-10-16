'use node';

import { v, type Infer } from 'convex/values';
import { z } from 'zod';
import { APIConnectionTimeoutError, APIError, ContextDev } from 'context.dev';
import type { WebScrapeParams, WebScrapeResponse } from 'context.dev/resources/web';
import { ExaClient } from '@exalabs/convex-exa';
import type { DeveloperSearchOptions } from 'firecrawl';
import { env, internalAction, type ActionCtx } from '@convex/_generated/server';
import { components, internal } from '@convex/_generated/api';
import {
	developerSearchTypes,
	vWebSearchResult,
	type ExecutorJobPayload,
	type vDeveloperSearchResults,
	type vPageOutline,
	type vScrapeUrlTransport
} from '@convex/lib/validators';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { HOSTED_PARSE_MAX_INPUT_BYTES } from '@convex/lib/hostedParse';
import { firecrawlClient, firecrawlFailure, firecrawlRetryAfterMs } from '@convex/lib/firecrawl';
import { retryAfterHeaderMs, retryRateLimited } from '@convex/lib/providerRetry';
import { NonRetryableError } from '@convex-dev/workpool';
import type { Doc } from '@convex/_generated/dataModel';

const exa = new ExaClient(components.exa);

const DEFAULT_SEARCH_RESULTS = 5;

const MAX_SEARCH_RESULTS = 10;

const SCRAPE_MAX_BYTES = 64 * 1024 * 1024;

export const SCRAPE_INLINE_MAX_CHARS = 40_000;

export const SCRAPE_STORAGE_TTL_MS = 60 * 60 * 1_000;

/** context.dev's own deadline for one scrape attempt. */
export const SCRAPE_TIMEOUT_MS = 60_000;

/** The SDK must outwait the API deadline so the API reports the timeout. */
const SDK_TIMEOUT_MARGIN_MS = 10_000;

/** Time a queued request keeps for storing and publishing its result. */
const REQUEST_PUBLISH_MARGIN_MS = 30_000;

export const HIGHLIGHTS_MAX_CHARS = 10_000;

const OUTLINE_MAX_CHARS = 8_000;

const OUTLINE_HEADING_MAX_CHARS = 200;

const OUTLINE_DESCRIPTION_MAX_CHARS = 1_000;

export const CONTEXT_DEV_CREDITS_EXHAUSTED = 'context.dev credits are exhausted.';

export const DEVELOPER_SEARCH_RESULTS = 10;

export const DEVELOPER_SEARCH_PASSAGES = 5;

const DEVELOPER_SEARCH_TIMEOUT_MS = 60_000;

const RAW_DOCUMENT_TOO_LARGE = 'Document exceeds the 50 MB raw fetch limit.';

const SCRAPE_JSON_BLOB_TYPE = 'application/json; charset=utf-8';

const CONVEX_ARRAY_MAX_LENGTH = 8_192;

const SEARCH_RESULT_TEXT_MAX_CHARS = 2_000;

const SEARCH_TIMEOUT_MS = 30_000;

class WebProviderTimeout extends Error {}

const contextDevErrorBodySchema = z.object({
	error_code: z.string().optional(),
	code: z.string().optional(),
	message: z.string().optional()
});

type PageOutline = Infer<typeof vPageOutline>;

type ScrapeParams = Omit<WebScrapeParams, 'maxAgeMs' | 'timeoutOpts'>;

type WebSearchJobArgs = { query: string; numResults?: number };

type ScrapeJobArgs = { url: string; query?: string };

export type ScrapedPage = {
	url: string;
	markdown: string;
	outline: PageOutline;
	highlights?: string[];
	images: string[];
};

/** `documentUrl` is a temporary storage URL for the unparsed document bytes. */
export type RawDocument = {
	url: string;
	documentUrl: string;
	contentType?: string;
};

type DeveloperSearchResults = Infer<typeof vDeveloperSearchResults>;

type WebRequest = Pick<
	Doc<'webRequests'>,
	'runId' | 'claimId' | 'jobId' | 'kind' | 'rawDocument' | 'expiresAt'
>;

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

function requireHttpUrl(urlValue: string): URL {
	let url: URL;

	try {
		url = new URL(urlValue.trim());
	} catch {
		throw new Error(`Invalid URL: ${urlValue}`);
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Only http(s) URLs can be scraped.');
	}

	return url;
}

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

	const body = contextDevErrorBodySchema.safeParse(error.error).data;
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

async function requestContextDevScrape(
	params: ScrapeParams,
	deadline: number
): Promise<WebScrapeResponse> {
	return await retryRateLimited({
		deadline,
		maxAttemptMs: SCRAPE_TIMEOUT_MS,
		attempt: async (timeoutMs) =>
			await contextDevClient().web.scrape(
				{ ...params, maxAgeMs: 0, timeoutOpts: { milliseconds: timeoutMs, behavior: 'fail' } },
				{ timeout: timeoutMs + SDK_TIMEOUT_MARGIN_MS }
			),
		retryAfterMs: contextDevRetryAfterMs,
		failure: contextDevFailure
	});
}

type ScrapeOutput = { success: boolean | null; error_code?: string; message?: string };

/** Failed outputs arrive inside HTTP 200 responses. */
function requireOutput(output: ScrapeOutput): void {
	if (output.success !== false) return;

	const message = output.message?.trim() || 'The page could not be scraped.';

	throw new Error(`This webpage returned an error: ${message} (${output.error_code ?? 'UNKNOWN'})`);
}

function pageOutline(metadata: WebScrapeResponse.Metadata): PageOutline {
	const outline: PageOutline = { headings: [] };

	const title = metadata.title?.trim().slice(0, OUTLINE_HEADING_MAX_CHARS);
	const description = metadata.description?.trim().slice(0, OUTLINE_DESCRIPTION_MAX_CHARS);

	if (title) outline.title = title;

	if (description) outline.description = description;

	let size = JSON.stringify(outline).length;

	for (const heading of metadata.headings ?? []) {
		const text = heading.text.trim().slice(0, OUTLINE_HEADING_MAX_CHARS);

		if (!text) continue;
		const entry = { level: heading.level, text };
		size += JSON.stringify(entry).length + 1;

		if (size > OUTLINE_MAX_CHARS) break;
		outline.headings.push(entry);
	}

	return outline;
}

async function fetchScrape(
	urlValue: string,
	query: string | undefined,
	deadline: number
): Promise<ScrapedPage> {
	const url = requireHttpUrl(urlValue);
	const highlightsQuery = query?.trim();

	const params: ScrapeParams = {
		url: url.toString(),
		formats: { markdown: true, images: true },
		sharedParams: { mainContentOnly: true }
	};

	if (highlightsQuery) {
		params.formats = { ...params.formats, highlights: true };
		params.highlightsParams = { query: highlightsQuery, maxCharacters: HIGHLIGHTS_MAX_CHARS };
	}

	const response = await requestContextDevScrape(params, deadline);

	requireOutput(response.markdown);

	const page: ScrapedPage = {
		url: response.url || url.toString(),
		markdown: response.markdown.data ?? '',
		outline: pageOutline(response.metadata),
		images: (response.images.data ?? [])
			.map((image) => image.url)
			.filter((imageUrl) => !imageUrl.startsWith('data:'))
	};

	if (highlightsQuery && response.highlights.success && response.highlights.data) {
		page.highlights = response.highlights.data;
	}

	return page;
}

/**
 * Fetches unparsed bytes for local parsing when the agent cannot reach the
 * document itself.
 */
async function fetchRawDocument(
	ctx: ActionCtx,
	urlValue: string,
	deadline: number
): Promise<RawDocument> {
	const url = requireHttpUrl(urlValue);

	const response = await requestContextDevScrape(
		{ url: url.toString(), formats: { bytes: true } },
		deadline
	);

	if (response.bytes.error_code === 'CONTENT_TOO_LARGE') throw new Error(RAW_DOCUMENT_TOO_LARGE);
	requireOutput(response.bytes);

	const document = new Uint8Array(Buffer.from(response.bytes.data?.base64 ?? '', 'base64'));

	if (document.byteLength === 0) {
		throw new Error('context.dev returned an empty document.');
	}

	if (document.byteLength > HOSTED_PARSE_MAX_INPUT_BYTES) {
		throw new Error(RAW_DOCUMENT_TOO_LARGE);
	}

	const raw: RawDocument = {
		url: response.url || url.toString(),
		documentUrl: await storeTemporaryBlob(ctx, new Blob([document]))
	};

	const contentType = response.bytes.data?.contentType;

	if (contentType) raw.contentType = contentType;

	return raw;
}

function localInlineFits(page: ScrapedPage): boolean {
	return (
		page.images.length <= CONVEX_ARRAY_MAX_LENGTH &&
		JSON.stringify(page).length <= SCRAPE_INLINE_MAX_CHARS
	);
}

async function localScrapeTransport(
	ctx: ActionCtx,
	page: ScrapedPage
): Promise<Infer<typeof vScrapeUrlTransport>> {
	if (localInlineFits(page)) {
		return page;
	}

	const transport: Infer<typeof vScrapeUrlTransport> = {
		url: page.url,
		outline: page.outline,
		scrapeUrl: await storeTemporaryScrape(ctx, page)
	};

	if (page.highlights) transport.highlights = page.highlights;

	return transport;
}

async function storeTemporaryScrape(ctx: ActionCtx, page: ScrapedPage): Promise<string> {
	const blob = new Blob([JSON.stringify(page)], { type: SCRAPE_JSON_BLOB_TYPE });

	if (blob.size > SCRAPE_MAX_BYTES) {
		throw new Error('Scrape exceeds the 64 MiB download limit.');
	}

	return await storeTemporaryBlob(ctx, blob);
}

async function storeTemporaryBlob(ctx: ActionCtx, blob: Blob): Promise<string> {
	const storageId = await ctx.storage.store(blob);

	try {
		await ctx.scheduler.runAfter(
			SCRAPE_STORAGE_TTL_MS,
			internal.hostedParse.deleteUnregisteredStorage,
			{ storageId }
		);
	} catch (error) {
		await ctx.storage.delete(storageId);
		throw error;
	}

	const url = await ctx.storage.getUrl(storageId);

	if (!url) {
		await ctx.storage.delete(storageId);
		throw new Error('Stored scrape is unavailable.');
	}

	return url;
}

type DeveloperSearchArgs = {
	query: string;
	types?: (typeof developerSearchTypes)[number][];
	repos?: string[];
};

async function runDeveloperSearch(
	args: DeveloperSearchArgs,
	deadline: number
): Promise<DeveloperSearchResults> {
	const query = args.query.trim();

	if (!query) throw new Error('Search query cannot be empty.');

	const options: DeveloperSearchOptions = {
		k: DEVELOPER_SEARCH_RESULTS,
		passages: DEVELOPER_SEARCH_PASSAGES
	};

	if (args.types?.length) options.types = args.types;

	if (args.repos?.length) options.repos = args.repos;

	const response = await retryRateLimited({
		deadline,
		maxAttemptMs: DEVELOPER_SEARCH_TIMEOUT_MS,
		attempt: async (timeoutMs) => await firecrawlClient(timeoutMs).developerSearch(query, options),
		retryAfterMs: firecrawlRetryAfterMs,
		failure: (error) => firecrawlFailure('Developer search', error)
	});

	const results: DeveloperSearchResults = {
		results: response.results.map((result) => {
			const item: DeveloperSearchResults['results'][number] = {
				url: result.url,
				passages: result.passages.map((passage) =>
					passage.citation_url
						? { text: passage.text, citationUrl: passage.citation_url }
						: { text: passage.text }
				)
			};

			if (result.title) item.title = result.title;

			return item;
		})
	};

	if (response.repos) {
		results.repos = response.repos.map(({ repo, indexed, types }) => ({
			repo,
			indexed,
			types: { issue: types.issue, pullRequest: types.pullRequest, readme: types.readme }
		}));
	}

	return results;
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

	let response: Awaited<ReturnType<typeof exa.search>>;

	try {
		response = await withTimeout(
			'Exa search',
			SEARCH_TIMEOUT_MS,
			exa.search(ctx, {
				query,
				type: 'auto',
				numResults,
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

function webSearchFromPayload(payload: ExecutorJobPayload): WebSearchJobArgs {
	if (!('query' in payload) || payload.query === undefined) return { query: '' };

	if (!('numResults' in payload) || payload.numResults === undefined) {
		return { query: payload.query };
	}

	return { query: payload.query, numResults: payload.numResults };
}

export const executeWebSearch = internalAction({
	args: executeArgs,
	returns: vWebSearchResult,
	handler: async (ctx, args): Promise<Infer<typeof vWebSearchResult>> => {
		const job = await ctx.runMutation(internal.webSearchPool.getWebSearchJob, args);

		if (!job || job.kind !== 'web_search') {
			throw new NonRetryableError(RUN_NO_LONGER_ACTIVE);
		}

		const search = webSearchFromPayload(job.payload);

		return await runSearch(ctx, search.query, search.numResults);
	}
});

function scrapeFromPayload(payload: ExecutorJobPayload): ScrapeJobArgs {
	if (!('url' in payload)) return { url: '' };

	return 'query' in payload && payload.query !== undefined
		? { url: payload.url, query: payload.query }
		: { url: payload.url };
}

function developerSearchFromPayload(payload: ExecutorJobPayload): DeveloperSearchArgs {
	if (!('query' in payload) || payload.query === undefined) return { query: '' };
	const args: DeveloperSearchArgs = { query: payload.query };

	if ('types' in payload && payload.types) args.types = payload.types;

	if ('repos' in payload && payload.repos) args.repos = payload.repos;

	return args;
}

export async function executeQueuedWebRequest(ctx: ActionCtx, request: WebRequest) {
	const job = await ctx.runMutation(internal.webRequests.requestJob, {
		jobId: request.jobId,
		runId: request.runId,
		claimId: request.claimId
	});

	const deadline = request.expiresAt - REQUEST_PUBLISH_MARGIN_MS;

	if (request.kind === 'developer_search') {
		if (job?.kind !== 'developer_search') throw new Error(RUN_NO_LONGER_ACTIVE);

		return await runDeveloperSearch(developerSearchFromPayload(job.payload), deadline);
	}

	if (job?.kind !== 'scrape_url') throw new Error(RUN_NO_LONGER_ACTIVE);
	const scrape = scrapeFromPayload(job.payload);

	if (request.rawDocument) return await fetchRawDocument(ctx, scrape.url, deadline);

	return await localScrapeTransport(ctx, await fetchScrape(scrape.url, scrape.query, deadline));
}
