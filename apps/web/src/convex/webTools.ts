'use node';

import { ConvexError, v, type Infer } from 'convex/values';
import { z } from 'zod';
import { FirecrawlClient, type ScrapeOptions } from '@firecrawl/firecrawl-convex';
import { ExaClient } from '@exalabs/convex-exa';
import { action, internalAction, type ActionCtx } from '@convex/_generated/server';
import { components, internal } from '@convex/_generated/api';
import {
	vScrapeUrlTransport,
	vScreenshotUrlTransport,
	vWebSearchResult,
	type ExecutorJobPayload
} from '@convex/lib/validators';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { NonRetryableError } from '@convex-dev/workpool';
import type { Doc } from '@convex/_generated/dataModel';

const firecrawl = new FirecrawlClient(components.firecrawl);
const exa = new ExaClient(components.exa);

const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const SCRAPE_MAX_BYTES = 64 * 1024 * 1024;
export const SCRAPE_INLINE_MAX_CHARS = 40_000;
export const SCRAPE_STORAGE_TTL_MS = 60 * 60 * 1_000;
export const SCRAPE_TIMEOUT_MS = 60_000;
export const SCRAPE_FORMATS = ['markdown', 'summary', 'images'] as const;
export const SCREENSHOT_FORMATS = ['screenshot'] as const;
export const DEFAULT_SCRAPE_SUMMARY = 'No summary was returned for this page.';
const SCRAPE_JSON_BLOB_TYPE = 'application/json; charset=utf-8';
const CONVEX_ARRAY_MAX_LENGTH = 8_192;
const SEARCH_RESULT_TEXT_MAX_CHARS = 2_000;
const SEARCH_TIMEOUT_MS = 30_000;
const SCRAPE_URL_SIZE_PLACEHOLDER = 'https://example.convex.cloud/api/storage/scrape.json';

class WebToolTimeout extends Error {}

const UNCAUGHT_CONVEX_ERROR_PREFIX = 'Uncaught ConvexError: ';
const firecrawlApiErrorSchema = z.object({
	code: z.literal('firecrawl_request_failed'),
	status: z.int().min(400).max(599)
});
const firecrawlMissingKeySchema = z.object({
	code: z.literal('firecrawl_missing_api_key')
});
const scrapeHttpErrorSchema = z.object({ status: z.int().min(400).max(599) });
const providerErrorSchema = z.union([
	firecrawlApiErrorSchema,
	firecrawlMissingKeySchema,
	scrapeHttpErrorSchema
]);
type ProviderError = z.infer<typeof providerErrorSchema>;
const firecrawlDocumentSchema = z.object({
	markdown: z.string().nullish(),
	summary: z.string().nullish(),
	images: z.array(z.string()).nullish(),
	screenshot: z.string().nullish(),
	metadata: z
		.object({
			url: z.string().optional(),
			sourceURL: z.string().optional(),
			statusCode: z.number().optional(),
			error: z.string().optional()
		})
		.passthrough()
		.optional()
});
type FirecrawlDocument = z.infer<typeof firecrawlDocumentSchema>;

export type ScrapedPage = {
	url: string;
	markdown: string;
	summary: string;
	images: string[];
};

function convexErrorData(error: Error): ProviderError | undefined {
	if (error instanceof ConvexError) {
		return providerErrorSchema.safeParse(error.data).data;
	}
	let message = error.message.split('\n', 1)[0] ?? '';
	while (message.startsWith(UNCAUGHT_CONVEX_ERROR_PREFIX)) {
		message = message.slice(UNCAUGHT_CONVEX_ERROR_PREFIX.length);
	}
	try {
		return providerErrorSchema.safeParse(JSON.parse(message)).data;
	} catch {
		return undefined;
	}
}

/** Firecrawl API HTTP status, not the scraped page's `metadata.statusCode`. */
export function scrapeHttpErrorStatus(error: Error): number | undefined {
	const data = convexErrorData(error);
	const firecrawlError = firecrawlApiErrorSchema.safeParse(data);
	if (firecrawlError.success) {
		return firecrawlError.data.status;
	}
	const result = scrapeHttpErrorSchema.safeParse(data);
	return result.success ? result.data.status : undefined;
}

export function isCleanPageStatus(status: number): boolean {
	return status === 304 || (status >= 200 && status < 300);
}

function isRetryableHttpStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function throwHttpFailure(message: string, status: number, cause?: Error): never {
	if (isRetryableHttpStatus(status)) {
		throw new ConvexError(message);
	}
	throw new NonRetryableError(message, cause ? { cause } : undefined);
}

export function summaryFitsTransport(page: ScrapedPage): boolean {
	return (
		JSON.stringify({
			url: page.url,
			summary: page.summary,
			scrapeUrl: SCRAPE_URL_SIZE_PLACEHOLDER
		}).length <= SCRAPE_INLINE_MAX_CHARS
	);
}

export function localInlineFits(page: ScrapedPage): boolean {
	return (
		page.images.length <= CONVEX_ARRAY_MAX_LENGTH &&
		JSON.stringify(page).length <= SCRAPE_INLINE_MAX_CHARS
	);
}

function rejectOversizedSummary(): never {
	throw new NonRetryableError('Scrape summary is too large.');
}

function scrapeSummary(value: string | null | undefined): string {
	if (value === undefined || value === null || value.trim() === '') {
		return DEFAULT_SCRAPE_SUMMARY;
	}
	return value;
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

function urlFromPayload(payload: ExecutorJobPayload): string {
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

function requireHttpUrl(urlValue: string): URL {
	let url: URL;
	try {
		url = new URL(urlValue.trim());
	} catch {
		throw new NonRetryableError(`Invalid URL: ${urlValue}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new NonRetryableError('Only http(s) URLs can be scraped.');
	}
	return url;
}

async function requestFirecrawlScrape(
	ctx: ActionCtx,
	url: URL,
	options: ScrapeOptions
): Promise<FirecrawlDocument> {
	let document: unknown;
	try {
		document = await withTimeout(
			'Firecrawl scrape',
			SCRAPE_TIMEOUT_MS,
			firecrawl.scrape(ctx, url.toString(), {
				...options,
				maxAge: 0,
				storeInCache: false,
				timeout: SCRAPE_TIMEOUT_MS
			})
		);
	} catch (error) {
		if (error instanceof Error) {
			if (firecrawlMissingKeySchema.safeParse(convexErrorData(error)).success) {
				throw new NonRetryableError('FIRECRAWL_API_KEY is not configured.', { cause: error });
			}
			const status = scrapeHttpErrorStatus(error);
			if (status !== undefined) {
				throwHttpFailure(`Firecrawl scrape failed (${status}).`, status, error);
			}
		}
		throw error;
	}
	const parsed = firecrawlDocumentSchema.safeParse(document);
	if (!parsed.success) {
		throw new NonRetryableError('Firecrawl scrape returned an invalid response.');
	}
	const statusCode = parsed.data.metadata?.statusCode;
	if (statusCode !== undefined && !isCleanPageStatus(statusCode)) {
		throwHttpFailure(`This webpage returned a ${statusCode} error.`, statusCode);
	}
	return parsed.data;
}

async function fetchScrape(ctx: ActionCtx, urlValue: string): Promise<ScrapedPage> {
	const url = requireHttpUrl(urlValue);
	const document = await requestFirecrawlScrape(ctx, url, {
		formats: [...SCRAPE_FORMATS],
		onlyMainContent: true
	});
	const page: ScrapedPage = {
		url: document.metadata?.sourceURL ?? document.metadata?.url ?? url.toString(),
		markdown: document.markdown ?? '',
		summary: scrapeSummary(document.summary),
		images: document.images ?? []
	};
	return page;
}

async function fetchScreenshot(
	ctx: ActionCtx,
	urlValue: string
): Promise<Infer<typeof vScreenshotUrlTransport>> {
	const url = requireHttpUrl(urlValue);
	const document = await requestFirecrawlScrape(ctx, url, {
		formats: [...SCREENSHOT_FORMATS]
	});
	const screenshot = document.screenshot?.trim() ?? '';
	if (!screenshot) {
		throw new NonRetryableError('Firecrawl screenshot is unavailable.');
	}
	try {
		requireHttpUrl(screenshot);
	} catch {
		throw new NonRetryableError('Firecrawl screenshot returned an invalid URL.');
	}
	return {
		url: url.toString(),
		screenshotUrl: screenshot
	};
}

async function localScrapeTransport(
	ctx: ActionCtx,
	page: ScrapedPage
): Promise<Infer<typeof vScrapeUrlTransport>> {
	if (!summaryFitsTransport(page)) {
		rejectOversizedSummary();
	}
	if (localInlineFits(page)) {
		return page;
	}
	return { url: page.url, summary: page.summary, scrapeUrl: await storeTemporaryScrape(ctx, page) };
}

async function storeTemporaryScrape(ctx: ActionCtx, page: ScrapedPage): Promise<string> {
	const blob = new Blob([JSON.stringify(page)], { type: SCRAPE_JSON_BLOB_TYPE });
	if (blob.size > SCRAPE_MAX_BYTES) {
		throw new NonRetryableError('Scrape exceeds the 64 MiB download limit.');
	}
	const storageId = await ctx.storage.store(blob);
	try {
		await ctx.scheduler.runAfter(
			SCRAPE_STORAGE_TTL_MS,
			internal.webToolPool.deleteTemporaryStorage,
			{ storageId }
		);
	} catch (error) {
		await ctx.storage.delete(storageId);
		throw error;
	}
	const scrapeUrl = await ctx.storage.getUrl(storageId);
	if (!scrapeUrl) {
		await ctx.storage.delete(storageId);
		throw new Error('Stored scrape is unavailable.');
	}
	return scrapeUrl;
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

export const executeWebSearch = internalAction({
	args: executeArgs,
	returns: vWebSearchResult,
	handler: async (ctx, args): Promise<Infer<typeof vWebSearchResult>> => {
		const job = await ctx.runMutation(internal.webToolPool.getWebToolJob, args);
		if (!job || job.kind !== 'web_search') {
			throw new NonRetryableError(RUN_NO_LONGER_ACTIVE);
		}
		const search = webSearchFromPayload(job.payload);
		return await runSearch(ctx, search.query, search.numResults);
	}
});

/** Retired blocking scrape action. Current agents use the Firecrawl request subscription. */
export const scrapeForTool = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		jobId: v.id('executorJobs'),
		executionSecret: v.string()
	},
	returns: vScrapeUrlTransport,
	handler: async () => {
		unsupportedClient();
	}
});

/** Retired blocking screenshot action. Current agents use the Firecrawl request subscription. */
export const screenshotForTool = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		jobId: v.id('executorJobs'),
		executionSecret: v.string()
	},
	returns: vScreenshotUrlTransport,
	handler: async () => {
		unsupportedClient();
	}
});

export async function executeQueuedScrape(
	ctx: ActionCtx,
	request: Pick<Doc<'firecrawlRequests'>, 'runId' | 'claimId' | 'jobId' | 'kind'>
) {
	const job = request.jobId
		? await ctx.runMutation(internal.firecrawlRequests.scrapeJob, {
				jobId: request.jobId,
				runId: request.runId,
				claimId: request.claimId
			})
		: null;
	if (!job || job.kind !== `${request.kind}_url`) throw new NonRetryableError(RUN_NO_LONGER_ACTIVE);
	if (request.kind === 'scrape') {
		return await localScrapeTransport(ctx, await fetchScrape(ctx, urlFromPayload(job.payload)));
	}
	return await fetchScreenshot(ctx, urlFromPayload(job.payload));
}
