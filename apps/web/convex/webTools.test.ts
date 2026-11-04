import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionTimeoutError, APIError } from 'context.dev';
import type { WebScrapeParams, WebScrapeResponse } from 'context.dev/resources/web';
import { isNonRetryableError } from '@convex-dev/workpool';
import { patchRunExecution } from '@convex/lib/runExecution';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { REQUEST_TTL_MS } from '@convex/webRequests';
import {
	CONTEXT_DEV_CREDITS_EXHAUSTED,
	HIGHLIGHTS_MAX_CHARS,
	SCRAPE_INLINE_MAX_CHARS,
	SCRAPE_STORAGE_TTL_MS,
	SCRAPE_TIMEOUT_MS,
	classifyExaSearchFailure,
	executeQueuedWebRequest,
	type ScrapedPage
} from '@convex/webTools';
import {
	contextDevScrapeResponse,
	createQueuedRun,
	fixtureWorkId,
	initConvexTest,
	mockContextDevScrape,
	seedOwnedThread,
	toolTranscriptAssignment,
	type ConvexTestInstance
} from './test.setup';

const scrape =
	vi.fn<(body: WebScrapeParams, options?: { timeout?: number }) => Promise<WebScrapeResponse>>();

const PAGE_URL = 'https://example.com/page';

type JobKind = 'scrape_url' | 'web_search';

async function seedJob(
	t: ConvexTestInstance,
	kind: JobKind,
	payload: { url: string; query?: string } | { query: string }
) {
	const executionSecret = crypto.randomUUID();
	const claimId = 'claim-a';
	const { asUser, threadId } = await seedOwnedThread(t);

	const { runId } = await createQueuedRun(t, asUser, threadId, executionSecret, executionSecret);

	await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });

	const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
		runId,
		claimId,
		...toolTranscriptAssignment(runId, claimId),
		kind,
		payload,
		executionSecret
	});

	return { asUser, runId, claimId, jobId, executionSecret };
}

async function runRequest(
	t: ConvexTestInstance,
	job: { runId: Id<'runs'>; claimId: string; jobId: Id<'executorJobs'> },
	options: { rawDocument?: boolean } = {}
) {
	const request = await t.run(async (ctx) => {
		const id = await ctx.db.insert('webRequests', {
			runId: job.runId,
			claimId: job.claimId,
			jobId: job.jobId,
			kind: 'scrape',
			status: 'running',
			expiresAt: Date.now() + REQUEST_TTL_MS
		});

		if (options.rawDocument) await ctx.db.patch('webRequests', id, { rawDocument: true });

		return (await ctx.db.get('webRequests', id))!;
	});

	return await t.action(async (ctx) => await executeQueuedWebRequest(ctx, request));
}

async function scrapePage(t: ConvexTestInstance, payload: { url: string; query?: string }) {
	const job = await seedJob(t, 'scrape_url', payload);
	const result = await runRequest(t, job);

	if ('documentUrl' in result) throw new Error('Expected a page transport.');

	return result;
}

async function rawDocument(t: ConvexTestInstance, url = 'https://example.com/report.pdf') {
	const job = await seedJob(t, 'scrape_url', { url });
	const result = await runRequest(t, job, { rawDocument: true });

	if (!('documentUrl' in result)) throw new Error('Expected a raw document.');

	return result;
}

function scrapeResponse(overrides: Partial<WebScrapeResponse> = {}): WebScrapeResponse {
<<<<<<< HEAD
	return {
		bytes: emptyOutput,
		cache_metadata: { age_ms: 0, status: 'miss' },
		highlights: emptyOutput,
		html: emptyOutput,
		images: emptyOutput,
		json: emptyOutput,
		markdown: { data: '# Page', requested: true, success: true },
		metadata: { title: 'Page', headings: [{ level: 1, text: 'Page' }] },
		parsed: { ...emptyOutput, type: 'custom' },
		product: emptyOutput,
		profile: null,
		request_id: 'request-1',
		screenshot: emptyOutput,
		url: PAGE_URL,
		...overrides
	};
=======
	return contextDevScrapeResponse({ url: PAGE_URL, ...overrides });
>>>>>>> 4391ba9b (refactor(web): Ban TypeScript type assertions)
}

type ContextDevErrorBody = { error_code?: string; message?: string };

function contextDevError(
	status: number,
	body: ContextDevErrorBody,
	headers: Record<string, string> = {}
) {
	return APIError.generate(status, body, undefined, new Headers(headers));
}

async function scrapedOutline(t: ConvexTestInstance, metadata: WebScrapeResponse.Metadata) {
	scrape.mockResolvedValue(
		scrapeResponse({
			markdown: { data: 'x'.repeat(SCRAPE_INLINE_MAX_CHARS + 1), requested: true, success: true },
			metadata
		})
	);

	const result = await scrapePage(t, { url: PAGE_URL });

	if (!('outline' in result)) throw new Error('Expected a stored page transport.');

	return result.outline;
}

function lastScrapeCall() {
	const call = scrape.mock.lastCall;

	if (!call) throw new Error('Expected a context.dev scrape.');

	return { body: call[0], options: call[1] };
}

async function storageBlobs(t: ConvexTestInstance) {
	return await t.run(async (ctx) => ctx.db.system.query('_storage').collect());
}

async function storedText(t: ConvexTestInstance, storageId: Id<'_storage'>) {
	return await t.run(async (ctx) => {
		const blob = await ctx.storage.get(storageId);

		return { url: await ctx.storage.getUrl(storageId), text: blob ? await blob.text() : null };
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv('CONTEXT_DEV_API_KEY', 'context-dev-key');
	vi.stubEnv('FIRECRAWL_API_KEY', 'firecrawl-key');
	scrape.mockReset();
	mockContextDevScrape(scrape);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('Exa search failures', () => {
	it.each([400, 401, 402, 403])('does not retry HTTP %i', (status) => {
		const cause = new Error(
			`Uncaught Error: Exa /search failed (${status}): provider rejected the request`
		);

		const error = classifyExaSearchFailure(cause);

		expect(isNonRetryableError(error)).toBe(true);
		expect(error.message).toContain(`Exa search failed (${status}): provider rejected the request`);
	});

	it.each([408, 425, 429, 500, 503, 504])('retries transient HTTP %i', (status) => {
		const failure = new Error(`Exa /search failed (${status}): transient`);
		const error = classifyExaSearchFailure(failure);

		expect(error).toBe(failure);
		expect(isNonRetryableError(error)).toBe(false);
	});

	it('does not retry a missing API key', () => {
		const error = classifyExaSearchFailure(new Error('Missing EXA_API_KEY for the Exa component.'));
		expect(isNonRetryableError(error)).toBe(true);
	});

	it('preserves transport failures for retry', () => {
		const failure = new Error('fetch failed');
		expect(classifyExaSearchFailure(failure)).toBe(failure);
	});
});

describe('queued request job checks', () => {
	it('rejects cloud-enqueued scrape jobs before calling context.dev', async () => {
		const t = initConvexTest();
		const job = await seedJob(t, 'scrape_url', { url: PAGE_URL });

		await t.run(async (ctx) => {
			await ctx.db.patch('executorJobs', job.jobId, { cloudWorkId: fixtureWorkId('cloud-work') });
		});

		await expect(runRequest(t, job)).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
		expect(scrape).not.toHaveBeenCalled();
	});

	it('rejects an expired claim before calling context.dev', async () => {
		const t = initConvexTest();
		const job = await seedJob(t, 'scrape_url', { url: PAGE_URL });

		await t.run(async (ctx) => {
			await patchRunExecution(ctx, job.runId, { claimExpiresAt: Date.now() - 1 });
		});

		await expect(runRequest(t, job)).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
		expect(scrape).not.toHaveBeenCalled();
	});

	it('rejects a settled scrape job before calling context.dev', async () => {
		const t = initConvexTest();
		const job = await seedJob(t, 'scrape_url', { url: PAGE_URL });

		await job.asUser.mutation(api.executor.complete, {
			runId: job.runId,
			claimId: job.claimId,
			executionSecret: job.executionSecret,
			jobId: job.jobId,
			result: { url: PAGE_URL, markdown: 'done' }
		});

		await expect(runRequest(t, job)).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
		expect(scrape).not.toHaveBeenCalled();
	});

	it('rejects a scrape request for a web_search job', async () => {
		const t = initConvexTest();
		const job = await seedJob(t, 'web_search', { query: 'sprocket' });

		await expect(runRequest(t, job)).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
		expect(scrape).not.toHaveBeenCalled();
	});

	it('rejects a non-http URL before calling context.dev', async () => {
		const t = initConvexTest();

		await expect(scrapePage(t, { url: 'ftp://example.com/file' })).rejects.toThrow(
			'Only http(s) URLs can be scraped.'
		);
		expect(scrape).not.toHaveBeenCalled();
	});
});

describe('context.dev scrape', () => {
	it.each([{ url: PAGE_URL }, { url: PAGE_URL, query: '   ' }])(
		'requests fresh main-content markdown with images and no highlights for %j',
		async (payload) => {
			const t = initConvexTest();
			scrape.mockResolvedValue(scrapeResponse());

			const result = await scrapePage(t, payload);

			const { body, options } = lastScrapeCall();
			expect(body).toEqual({
				url: PAGE_URL,
				formats: { markdown: true },
				markdownParams: { includeImages: true },
				sharedParams: { mainContentOnly: true },
				maxAgeMs: 0,
				timeoutOpts: { milliseconds: SCRAPE_TIMEOUT_MS, behavior: 'fail' }
			});
			expect(options?.timeout).toBeGreaterThan(SCRAPE_TIMEOUT_MS);
			expect(result).not.toHaveProperty('highlights');
		}
	);

	it('requests and returns highlights for a query', async () => {
		const t = initConvexTest();

		scrape.mockResolvedValue(
			scrapeResponse({
				highlights: { data: ['Pricing starts at $5.'], requested: true, success: true }
			})
		);

		const result = await scrapePage(t, { url: PAGE_URL, query: '  pricing  ' });

		expect(lastScrapeCall().body).toMatchObject({
			formats: { markdown: true, highlights: true },
			highlightsParams: { query: 'pricing', maxCharacters: HIGHLIGHTS_MAX_CHARS }
		});
		expect(result).toMatchObject({ highlights: ['Pricing starts at $5.'] });
	});

	it('returns the page without highlights when only the highlights output failed', async () => {
		const t = initConvexTest();

		scrape.mockResolvedValue(
			scrapeResponse({
				highlights: {
					data: null,
					requested: true,
					success: false,
					error_code: 'HIGHLIGHTS_FAILED'
				}
			})
		);

		const result = await scrapePage(t, { url: PAGE_URL, query: 'pricing' });

		expect(result).toMatchObject({ url: PAGE_URL, markdown: '# Page' });
		expect(result).not.toHaveProperty('highlights');
	});

	it('maps metadata to an outline', async () => {
		const t = initConvexTest();

		const outline = await scrapedOutline(t, {
			title: '  Docs  ',
			description: '   ',
			headings: [
				{ level: 1, text: ' Docs ' },
				{ level: 2, text: '   ' },
				{ level: 2, text: 'Install' }
			]
		});

		expect(outline).toEqual({
			title: 'Docs',
			headings: [
				{ level: 1, text: 'Docs' },
				{ level: 2, text: 'Install' }
			]
		});
	});

	it('bounds the outline of a page with long metadata and many long headings', async () => {
		const t = initConvexTest();
		const longText = 'h'.repeat(100_000);

		const outline = await scrapedOutline(t, {
			title: longText,
			description: longText,
			headings: Array.from({ length: 5_000 }, () => ({ level: 2, text: longText }))
		});

		expect(outline.headings.length).toBeGreaterThan(0);
		expect(JSON.stringify(outline).length).toBeLessThan(SCRAPE_INLINE_MAX_CHARS / 2);
	});

	it('clips outline text at whole characters', async () => {
		const t = initConvexTest();
		const title = `${'a'.repeat(199)}😀`;

		const outline = await scrapedOutline(t, { title, headings: [] });

		expect(outline.title).toBe('a'.repeat(199));
	});

	it('fails with the page error from a failed markdown output', async () => {
		const t = initConvexTest();

		scrape.mockResolvedValue(
			scrapeResponse({
				markdown: {
					data: null,
					requested: true,
					success: false,
					error_code: 'NOT_FOUND',
					message: 'Page returned 404'
				}
			})
		);

		await expect(scrapePage(t, { url: PAGE_URL })).rejects.toThrow(
			'This webpage returned an error: Page returned 404 (NOT_FOUND)'
		);
		expect(await storageBlobs(t)).toEqual([]);
	});

	it('reports exhausted context.dev credits', async () => {
		const t = initConvexTest();

		scrape.mockRejectedValue(
			contextDevError(401, { error_code: 'USAGE_EXCEEDED', message: 'Monthly usage exceeded' })
		);

		await expect(scrapePage(t, { url: PAGE_URL })).rejects.toThrow(CONTEXT_DEV_CREDITS_EXHAUSTED);
	});

	it.each([
		{
			error: contextDevError(401, { error_code: 'INVALID_API_KEY', message: 'Bad key' }),
			message: 'context.dev scrape failed (401): INVALID_API_KEY: Bad key'
		},
		{
			error: contextDevError(500, { message: 'Upstream exploded' }),
			message: 'context.dev scrape failed (500): Upstream exploded'
		},
		{ error: contextDevError(408, {}), message: 'context.dev scrape timed out.' },
		{ error: new APIConnectionTimeoutError(), message: 'context.dev scrape timed out.' }
	])('maps "$message" without retrying', async ({ error, message }) => {
		const t = initConvexTest();
		scrape.mockRejectedValue(error);

		await expect(scrapePage(t, { url: PAGE_URL })).rejects.toThrow(message);
		expect(scrape).toHaveBeenCalledTimes(1);
	});

	it('waits out Retry-After on a rate limit, then retries', async () => {
		const t = initConvexTest();

		scrape
			.mockRejectedValueOnce(
				contextDevError(429, { message: 'Slow down' }, { 'retry-after': '30' })
			)
			.mockResolvedValueOnce(scrapeResponse());

		const result = scrapePage(t, { url: PAGE_URL });

		await vi.waitFor(() => expect(scrape).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(29_000);
		expect(scrape).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(2_000);
		expect(await result).toMatchObject({ url: PAGE_URL, markdown: '# Page' });
		expect(scrape).toHaveBeenCalledTimes(2);
	});

	it('requires an API key', async () => {
		const t = initConvexTest();
		vi.stubEnv('CONTEXT_DEV_API_KEY', ' ');

		await expect(scrapePage(t, { url: PAGE_URL })).rejects.toThrow(
			'CONTEXT_DEV_API_KEY is not configured.'
		);
		expect(scrape).not.toHaveBeenCalled();
	});
});

describe('scrape transport size', () => {
	function mockPage(page: Pick<ScrapedPage, 'markdown' | 'highlights'>) {
		const response = scrapeResponse({
			markdown: { data: page.markdown, requested: true, success: true },
			metadata: {}
		});

		if (page.highlights) {
			response.highlights = { data: page.highlights, requested: true, success: true };
		}

		scrape.mockResolvedValue(response);
	}

	it('returns the final URL and markdown at the inline budget without storage', async () => {
		const t = initConvexTest();
		const markdown = 'x'.repeat(SCRAPE_INLINE_MAX_CHARS);
		scrape.mockResolvedValue(
			scrapeResponse({
				url: 'https://example.com/final',
				markdown: { data: markdown, requested: true, success: true }
			})
		);

		expect(await scrapePage(t, { url: PAGE_URL })).toEqual({
			url: 'https://example.com/final',
			markdown
		});
		expect(await storageBlobs(t)).toEqual([]);
	});

	it('stores oversized markdown and returns the outline, highlights, and scrapeUrl', async () => {
		const t = initConvexTest();
		const markdown = `${'x'.repeat(SCRAPE_INLINE_MAX_CHARS)}é`;
		const highlights = ['x marks the spot'];
		mockPage({ markdown, highlights });

		const result = await scrapePage(t, { url: PAGE_URL, query: 'x' });

		expect(result).toEqual({
			url: PAGE_URL,
			outline: { headings: [] },
			highlights,
			scrapeUrl: expect.any(String)
		});

		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		const stored = await storedText(t, blobs[0]!._id);
		expect(stored.url).toBe('scrapeUrl' in result ? result.scrapeUrl : undefined);
		expect(stored.text).toBe(markdown);
	});

	it('deletes stored markdown after its TTL', async () => {
		const t = initConvexTest();
		mockPage({ markdown: 'x'.repeat(SCRAPE_INLINE_MAX_CHARS + 1) });

		await scrapePage(t, { url: PAGE_URL });
		expect(await storageBlobs(t)).toHaveLength(1);

		await t.finishAllScheduledFunctions(() => {
			vi.advanceTimersByTime(SCRAPE_STORAGE_TTL_MS);
		});
		expect(await storageBlobs(t)).toEqual([]);
	});

	it('rejects pages over the download limit without storing a blob', async () => {
		const t = initConvexTest();
		mockPage({ markdown: 'x'.repeat(64 * 1024 * 1024 + 1) });

		await expect(scrapePage(t, { url: PAGE_URL })).rejects.toThrow(
			'Scrape exceeds the 64 MiB download limit.'
		);
		expect(await storageBlobs(t)).toEqual([]);
	}, 15_000);

	it('accepts a page exactly at the download limit', async () => {
		const t = initConvexTest();
		mockPage({ markdown: 'x'.repeat(64 * 1024 * 1024) });

		expect(await scrapePage(t, { url: PAGE_URL })).toHaveProperty('scrapeUrl');
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		expect(blobs[0]?.size).toBe(64 * 1024 * 1024);
	}, 15_000);
});

describe('raw document fetch', () => {
	function bytesResponse(bytes: WebScrapeResponse.Bytes) {
		return scrapeResponse({ url: 'https://example.com/final.pdf', bytes });
	}

	it('requests only bytes and stores them for local parsing until the TTL', async () => {
		const t = initConvexTest();

		scrape.mockResolvedValue(
			bytesResponse({
				data: {
					base64: Buffer.from('%PDF-1.4').toString('base64'),
					contentType: 'application/pdf'
				},
				requested: true,
				success: true
			})
		);

		const result = await rawDocument(t);

		expect(lastScrapeCall().body).toEqual({
			url: 'https://example.com/report.pdf',
			formats: { bytes: true },
			maxAgeMs: 0,
			timeoutOpts: { milliseconds: SCRAPE_TIMEOUT_MS, behavior: 'fail' }
		});
		expect(result).toEqual({
			url: 'https://example.com/final.pdf',
			documentUrl: expect.any(String),
			contentType: 'application/pdf'
		});

		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		expect(await storedText(t, blobs[0]!._id)).toEqual({
			url: result.documentUrl,
			text: '%PDF-1.4'
		});

		await t.finishAllScheduledFunctions(() => {
			vi.advanceTimersByTime(SCRAPE_STORAGE_TTL_MS);
		});
		expect(await storageBlobs(t)).toEqual([]);
	});

	it.each([
		{
			bytes: { data: null, requested: true, success: false, error_code: 'CONTENT_TOO_LARGE' },
			message: 'Document exceeds the 50 MB raw fetch limit.'
		},
		{
			bytes: {
				data: null,
				requested: true,
				success: false,
				error_code: 'FETCH_FAILED',
				message: 'Origin refused'
			},
			message: 'This webpage returned an error: Origin refused (FETCH_FAILED)'
		},
		{
			bytes: {
				data: { base64: '', contentType: 'application/pdf' },
				requested: true,
				success: true
			},
			message: 'context.dev returned an empty document.'
		}
	])('fails with "$message" without storing bytes', async ({ bytes, message }) => {
		const t = initConvexTest();
		scrape.mockResolvedValue(bytesResponse(bytes));

		await expect(rawDocument(t)).rejects.toThrow(message);
		expect(await storageBlobs(t)).toEqual([]);
	});
});
