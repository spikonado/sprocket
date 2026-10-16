import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchRunExecution } from '@convex/lib/runExecution';
import { ConvexError, type Infer } from 'convex/values';
import { FirecrawlClient } from '@firecrawl/firecrawl-convex';
import { isNonRetryableError } from '@convex-dev/workpool';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { vScrapeUrlTransport } from '@convex/lib/validators';
import {
	DEFAULT_SCRAPE_SUMMARY,
	classifyExaSearchFailure,
	scrapeHttpErrorStatus,
	SCRAPE_INLINE_MAX_CHARS,
	SCRAPE_STORAGE_TTL_MS,
	SCRAPE_TIMEOUT_MS,
	FIRECRAWL_SCRAPE_URL,
	executeQueuedScrape,
	type ScrapedPage
} from '@convex/webTools';
import { initConvexTest, seedStartedWebJob, type ConvexTestInstance } from './test.setup';

const PAGE_URL = 'https://example.com/page';

type QueuedActionArgs = {
	runId: Id<'runs'>;
	claimId: string;
	jobId: Id<'executorJobs'>;
	executionSecret: string;
};

type ScrapeTransport = Infer<typeof vScrapeUrlTransport>;

async function queuedAction(
	t: Pick<ConvexTestInstance, 'action'>,
	kind: 'scrape',
	args: QueuedActionArgs
): Promise<ScrapeTransport> {
	return await t.action(async (ctx) => {
		await ctx.runQuery(api.agentRuntime.completionActor, {
			runId: args.runId,
			executionSecret: args.executionSecret
		});

		const result = await executeQueuedScrape(ctx, { ...args, kind });

		if ('documentUrl' in result) throw new Error('Expected a page transport.');

		return result;
	});
}

async function queuedRawDocument(t: ConvexTestInstance, url = 'https://example.com/report.pdf') {
	const { asUser, executionSecret, ...job } = await seedStartedWebJob(t, {
		executionSecret: 'raw-document-secret',
		kind: 'scrape_url',
		payload: { url }
	});

	return await asUser.action(async (ctx) => {
		await ctx.runQuery(api.agentRuntime.completionActor, {
			runId: job.runId,
			executionSecret
		});

		const result = await executeQueuedScrape(ctx, { ...job, kind: 'scrape', rawDocument: true });

		if (!('documentUrl' in result)) throw new Error('Expected a raw document.');

		return result;
	});
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
	}

	throw new Error('Expected an Error rejection.');
}

type FirecrawlRawDocumentResponse = {
	success: boolean;
	error?: string;
	data?: {
		rawBase64: string;
		metadata: { sourceURL?: string; contentType?: string; statusCode: number };
	};
};

function mockRawDocumentFetch(body: FirecrawlRawDocumentResponse, status = 200) {
	const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }));
	vi.stubGlobal('fetch', fetch);

	return fetch;
}

function firecrawlApiError(status: number) {
	return new ConvexError({
		code: 'firecrawl_request_failed',
		status,
		path: '/v2/scrape',
		message: `Firecrawl /v2/scrape failed (${status}): upstream`
	});
}

function mockScrape(
	document: {
		markdown?: string;
		summary?: string;
		images?: string[];
		metadata?: { sourceURL?: string; url?: string; statusCode?: number };
	},
	url = PAGE_URL
) {
	return vi.spyOn(FirecrawlClient.prototype, 'scrape').mockResolvedValue({
		markdown: document.markdown,
		summary: document.summary,
		images: document.images,
		metadata: document.metadata ?? { sourceURL: url, statusCode: 200 }
	});
}

function expectedScrapeArgs(url = PAGE_URL) {
	return [
		expect.anything(),
		url,
		{
			formats: ['markdown', 'summary', 'images'],
			onlyMainContent: true,
			maxAge: 0,
			storeInCache: false,
			timeout: SCRAPE_TIMEOUT_MS
		}
	] as const;
}

async function storageBlobs(t: ConvexTestInstance) {
	return await t.run(async (ctx) => ctx.db.system.query('_storage').collect());
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

describe('scrape HTTP failures', () => {
	it('reads nested Firecrawl API errors from the message JSON', () => {
		const error = new Error(
			`Uncaught ConvexError: Uncaught ConvexError: ${JSON.stringify({
				code: 'firecrawl_request_failed',
				status: 403,
				path: '/v2/scrape',
				message: 'Firecrawl /v2/scrape failed (403): forbidden'
			})}\n    at scrape (lib.js:24:12)`
		);

		expect(scrapeHttpErrorStatus(error)).toBe(403);
	});
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

describe('queued scrape auth', () => {
	it('scrapes the authorized URL with Firecrawl cache reads and writes disabled', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'local-scrape-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		const scrape = mockScrape({
			markdown: '# Page',
			summary: 'A page.',
			images: ['https://example.com/a.png']
		});

		try {
			expect(
				await queuedAction(asUser, 'scrape', {
					runId,
					claimId,
					jobId,
					executionSecret
				})
			).toEqual({
				url: PAGE_URL,
				markdown: '# Page',
				summary: 'A page.',
				images: ['https://example.com/a.png']
			});
			expect(scrape).toHaveBeenCalledWith(...expectedScrapeArgs());
		} finally {
			scrape.mockRestore();
		}
	});

	it('rejects a wrong execution secret', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId } = await seedStartedWebJob(t, {
			executionSecret: 'scrape-auth-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		await expect(
			queuedAction(asUser, 'scrape', {
				runId,
				claimId,
				jobId,
				executionSecret: 'wrong-secret'
			})
		).rejects.toThrow('Run not found.');
	});

	it('rejects cloud-enqueued scrape jobs', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'cloud-scrape-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/cloud' }
		});

		await t.run(async (ctx) => {
			await ctx.db.patch('executorJobs', jobId, { cloudWorkId: 'cloud-work' });
		});
		await expect(
			queuedAction(asUser, 'scrape', {
				runId,
				claimId,
				jobId,
				executionSecret
			})
		).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
	});

	it('rejects web_search jobs', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'search-scrape-secret',
			kind: 'web_search',
			payload: { query: 'sprocket' }
		});

		await expect(
			queuedAction(asUser, 'scrape', {
				runId,
				claimId,
				jobId,
				executionSecret
			})
		).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
	});

	it('rejects an expired claim', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'expired-scrape-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		await t.run(async (ctx) => {
			await patchRunExecution(ctx, runId, { claimExpiresAt: Date.now() - 1 });
		});
		await expect(
			queuedAction(asUser, 'scrape', {
				runId,
				claimId,
				jobId,
				executionSecret
			})
		).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
		expect(
			await t.mutation(internal.firecrawlRequests.scrapeJob, {
				runId,
				claimId,
				jobId
			})
		).toBeNull();
	});

	it('rejects a settled local scrape job', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'settled-scrape-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		await asUser.mutation(api.executor.complete, {
			runId,
			claimId,
			executionSecret,
			jobId,
			result: { url: PAGE_URL, markdown: 'done', summary: 'Done.', images: [] }
		});
		await expect(
			queuedAction(asUser, 'scrape', {
				runId,
				claimId,
				jobId,
				executionSecret
			})
		).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
	});
});

describe('stored scrape_url results', () => {
	it('stores scrape results with summary and images', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'saved-path-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		await asUser.mutation(api.executor.complete, {
			runId,
			claimId,
			executionSecret,
			jobId,
			result: {
				url: PAGE_URL,
				markdown:
					'The scrape was too large to directly output. Instead, it has been saved to /tmp/scrape.md for you to view.',
				summary: 'Saved scrape.',
				images: []
			}
		});
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job?.result).toEqual({
			url: PAGE_URL,
			markdown:
				'The scrape was too large to directly output. Instead, it has been saved to /tmp/scrape.md for you to view.',
			summary: 'Saved scrape.',
			images: []
		});
		expect(job?.result).not.toHaveProperty('truncated');
	});

	it('stores scrape results with summary and image lists', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'stored-scrape-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		await asUser.mutation(api.executor.complete, {
			runId,
			claimId,
			executionSecret,
			jobId,
			result: {
				url: PAGE_URL,
				markdown: 'partial',
				summary: 'Partial page.',
				images: []
			}
		});
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job?.result).toEqual({
			url: PAGE_URL,
			markdown: 'partial',
			summary: 'Partial page.',
			images: []
		});
	});
});

async function scrapeLocalPage(
	document: {
		markdown?: string;
		summary?: string;
		images?: string[];
	},
	url = PAGE_URL
) {
	const t = initConvexTest();

	const seeded = await seedStartedWebJob(t, {
		executionSecret: `local-md-${Math.random()}`,
		kind: 'scrape_url',
		payload: { url }
	});

	const scrape = mockScrape(document, url);

	try {
		const result = await queuedAction(seeded.asUser, 'scrape', {
			runId: seeded.runId,
			claimId: seeded.claimId,
			jobId: seeded.jobId,
			executionSecret: seeded.executionSecret
		});

		return { t, result, scrapeCalls: scrape.mock.calls.map((call) => [...call]) };
	} finally {
		scrape.mockRestore();
	}
}

describe('scrape size budget', () => {
	it('rejects a summary that cannot fit the inline budget', async () => {
		const page: ScrapedPage = {
			url: PAGE_URL,
			markdown: 'hi',
			summary: 's'.repeat(SCRAPE_INLINE_MAX_CHARS),
			images: []
		};

		await expect(scrapeLocalPage(page)).rejects.toThrow('Scrape summary is too large.');
	});
});

describe('queued scrape markdown transport', () => {
	it('rejects oversized JSON archives without storing a blob', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'oversized-markdown-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/page' }
		});

		const scrape = mockScrape({ markdown: `${'é'.repeat(32 * 1024 * 1024)}x` });

		try {
			await expect(
				queuedAction(asUser, 'scrape', {
					runId,
					claimId,
					jobId,
					executionSecret
				})
			).rejects.toThrow('Scrape exceeds the 64 MiB download limit.');
			expect(await storageBlobs(t)).toEqual([]);
		} finally {
			scrape.mockRestore();
		}
	});

	it('counts JSON escaping toward the receiver byte limit', async () => {
		await expect(
			scrapeLocalPage({ markdown: '\n'.repeat(32 * 1024 * 1024), summary: 'Summary' })
		).rejects.toThrow('Scrape exceeds the 64 MiB download limit.');
	}, 15_000);

	it('accepts a JSON archive exactly at the receiver byte limit', async () => {
		const page: ScrapedPage = { url: PAGE_URL, markdown: '', summary: 'Summary', images: [] };
		page.markdown = 'x'.repeat(64 * 1024 * 1024 - JSON.stringify(page).length);
		const { t, result } = await scrapeLocalPage(page);
		expect(result).toHaveProperty('scrapeUrl');
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		expect(blobs[0]?.size).toBe(64 * 1024 * 1024);
	}, 15_000);

	it('returns short markdown, summary, and images inline without truncated or storage', async () => {
		const markdown = 'x'.repeat(SCRAPE_INLINE_MAX_CHARS - 1_000);

		const { t, result, scrapeCalls } = await scrapeLocalPage({
			markdown,
			summary: 'A long but inline page.',
			images: ['https://example.com/a.png']
		});

		expect(result).toEqual({
			url: PAGE_URL,
			markdown,
			summary: 'A long but inline page.',
			images: ['https://example.com/a.png']
		});
		expect(result).not.toHaveProperty('truncated');
		expect(result).not.toHaveProperty('scrapeUrl');
		expect(scrapeCalls[0]).toEqual([...expectedScrapeArgs()]);
		expect(await storageBlobs(t)).toEqual([]);
	});

	it('uses an explicit default when Firecrawl omits summary', async () => {
		const { result } = await scrapeLocalPage({ markdown: '# Page', images: [] });
		expect(result).toEqual({
			url: PAGE_URL,
			markdown: '# Page',
			summary: DEFAULT_SCRAPE_SUMMARY,
			images: []
		});
	});

	it('stores the full scrape JSON including images and returns scrapeUrl', async () => {
		const markdown = `${'x'.repeat(SCRAPE_INLINE_MAX_CHARS)}é`;
		const images = ['https://example.com/a.png', 'https://example.com/b.png'];

		const archive = {
			url: PAGE_URL,
			markdown,
			summary: 'Huge page.',
			images
		};

		const expectedBytes = new TextEncoder().encode(JSON.stringify(archive));

		const { t, result, scrapeCalls } = await scrapeLocalPage({
			markdown,
			summary: 'Huge page.',
			images
		});

		expect(result).toEqual({
			url: PAGE_URL,
			summary: 'Huge page.',
			scrapeUrl: expect.any(String)
		});
		expect(result).not.toHaveProperty('truncated');
		expect(result).not.toHaveProperty('markdown');
		expect(scrapeCalls[0]).toEqual([...expectedScrapeArgs()]);

		if (!('scrapeUrl' in result)) throw new Error('expected scrapeUrl');
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		expect(blobs[0]?.size).toBe(expectedBytes.byteLength);

		const stored = await t.run(async (ctx) => {
			if (!blobs[0]) return null;
			const blob = await ctx.storage.get(blobs[0]._id);

			return {
				url: await ctx.storage.getUrl(blobs[0]._id),
				text: blob ? await new Response(blob).text() : null
			};
		});

		expect(stored?.url).toBe(result.scrapeUrl);
		expect(stored?.text ? JSON.parse(stored.text) : null).toEqual(archive);
	});

	it('stores full image lists when media, not markdown, overflows the budget', async () => {
		const images = [`https://cdn.example.com/${'x'.repeat(SCRAPE_INLINE_MAX_CHARS)}.png`];

		const archive = {
			url: PAGE_URL,
			markdown: 'short',
			summary: 'Images overflow.',
			images
		};

		const expectedBytes = new TextEncoder().encode(JSON.stringify(archive));

		const { t, result } = await scrapeLocalPage({
			markdown: 'short',
			summary: 'Images overflow.',
			images
		});

		expect(result).toEqual({
			url: PAGE_URL,
			summary: 'Images overflow.',
			scrapeUrl: expect.any(String)
		});
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		expect(blobs[0]?.size).toBe(expectedBytes.byteLength);
	});

	it('deletes stored scrape JSON after one hour', async () => {
		const markdown = `${'x'.repeat(SCRAPE_INLINE_MAX_CHARS)}y`;
		const { t } = await scrapeLocalPage({ markdown, summary: 'Expires.' });
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		const storageId = blobs[0]?._id;
		expect(storageId).toBeDefined();
		await t.finishAllScheduledFunctions(() => {
			vi.advanceTimersByTime(SCRAPE_STORAGE_TTL_MS);
		});
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId!))).toBeNull();
	});
});

describe('scrape errors', () => {
	it('rejects a missing Firecrawl API key without retrying', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'missing-key-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		const scrape = vi.spyOn(FirecrawlClient.prototype, 'scrape').mockRejectedValue(
			new ConvexError({
				code: 'firecrawl_missing_api_key',
				message: 'FIRECRAWL_API_KEY is not set for the Firecrawl component.'
			})
		);

		try {
			await expect(
				queuedAction(asUser, 'scrape', {
					runId,
					claimId,
					jobId,
					executionSecret
				})
			).rejects.toThrow('FIRECRAWL_API_KEY is not configured.');
		} finally {
			scrape.mockRestore();
		}
	});

	it('maps Firecrawl API 404 to a non-retryable scrape failure', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'api-404-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		const scrape = vi
			.spyOn(FirecrawlClient.prototype, 'scrape')
			.mockRejectedValue(firecrawlApiError(404));

		try {
			await expect(
				queuedAction(asUser, 'scrape', {
					runId,
					claimId,
					jobId,
					executionSecret
				})
			).rejects.toThrow('Firecrawl scrape failed (404).');
		} finally {
			scrape.mockRestore();
		}
	});

	it('maps page metadata.statusCode 404 separately from Firecrawl API errors', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'page-404-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		const scrape = mockScrape({
			markdown: 'missing',
			summary: 'Not found.',
			metadata: { sourceURL: PAGE_URL, statusCode: 404 }
		});

		try {
			await expect(
				queuedAction(asUser, 'scrape', {
					runId,
					claimId,
					jobId,
					executionSecret
				})
			).rejects.toThrow('This webpage returned a 404 error.');
		} finally {
			scrape.mockRestore();
		}
	});

	it('rejects invalid Firecrawl documents', async () => {
		const t = initConvexTest();

		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'invalid-doc-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});

		const scrape = vi.spyOn(FirecrawlClient.prototype, 'scrape').mockResolvedValue(
			// SAFETY: Deliberately malformed provider data exercises runtime validation.
			{ images: [1, 2, 3] } as never
		);

		try {
			await expect(
				queuedAction(asUser, 'scrape', {
					runId,
					claimId,
					jobId,
					executionSecret
				})
			).rejects.toThrow('Firecrawl scrape returned an invalid response.');
		} finally {
			scrape.mockRestore();
		}
	});
});

describe('queued raw document fetch', () => {
	beforeEach(() => vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test-key'));

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('fetches unparsed bytes and stores them for local parsing', async () => {
		const t = initConvexTest();
		const scrape = vi.spyOn(FirecrawlClient.prototype, 'scrape');

		const fetch = mockRawDocumentFetch({
			success: true,
			data: {
				rawBase64: Buffer.from('%PDF-1.4').toString('base64'),
				metadata: {
					sourceURL: 'https://example.com/final.pdf',
					contentType: 'application/pdf',
					statusCode: 200
				}
			}
		});

		try {
			const result = await queuedRawDocument(t);

			expect(result).toEqual({
				url: 'https://example.com/final.pdf',
				documentUrl: expect.any(String),
				contentType: 'application/pdf'
			});
			expect(scrape).not.toHaveBeenCalled();
			expect(fetch).toHaveBeenCalledTimes(1);
			const [url, init] = fetch.mock.calls[0]!;
			expect(url).toBe(FIRECRAWL_SCRAPE_URL);
			expect(init?.headers).toMatchObject({ Authorization: 'Bearer fc-test-key' });
			expect(JSON.parse(String(init?.body))).toEqual({
				url: 'https://example.com/report.pdf',
				formats: ['rawBase64'],
				parsers: [],
				maxAge: 0,
				storeInCache: false,
				timeout: SCRAPE_TIMEOUT_MS
			});

			const blobs = await storageBlobs(t);
			expect(blobs).toHaveLength(1);

			const stored = await t.run(async (ctx) => {
				const blob = await ctx.storage.get(blobs[0]!._id);

				return {
					url: await ctx.storage.getUrl(blobs[0]!._id),
					text: blob ? await blob.text() : null
				};
			});

			expect(stored).toEqual({
				url: result.documentUrl,
				text: '%PDF-1.4'
			});

			await t.finishAllScheduledFunctions(() => {
				vi.advanceTimersByTime(SCRAPE_STORAGE_TTL_MS);
			});
			expect(await storageBlobs(t)).toEqual([]);
		} finally {
			scrape.mockRestore();
		}
	});

	it('maps a page 404 to a non-retryable failure', async () => {
		const t = initConvexTest();

		mockRawDocumentFetch({
			success: true,
			data: { rawBase64: 'JVBERg==', metadata: { statusCode: 404 } }
		});

		const error = await rejection(queuedRawDocument(t));

		expect(error.message).toContain('This webpage returned a 404 error.');
		expect(isNonRetryableError(error)).toBe(true);
		expect(await storageBlobs(t)).toEqual([]);
	});

	it('retries Firecrawl rate limits', async () => {
		const t = initConvexTest();

		mockRawDocumentFetch({ success: false, error: 'Rate limited' }, 429);

		const error = await rejection(queuedRawDocument(t));

		expect(error.message).toContain('Firecrawl scrape failed (429).');
		expect(isNonRetryableError(error)).toBe(false);
	});

	it('keeps interrupted response reads retryable', async () => {
		const t = initConvexTest();

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"success":'));
				controller.error(new Error('connection reset'));
			}
		});

		vi.stubGlobal(
			'fetch',
			vi.fn<typeof globalThis.fetch>(async () => new Response(body))
		);

		const error = await rejection(queuedRawDocument(t));

		expect(error.message).toContain('connection reset');
		expect(isNonRetryableError(error)).toBe(false);
	});
});
