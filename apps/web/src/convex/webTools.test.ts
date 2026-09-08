import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import { FirecrawlClient } from '@firecrawl/firecrawl-convex';
import { api, internal } from '@convex/_generated/api';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { UNSUPPORTED_CLIENT_MESSAGE } from '@convex/lib/unsupportedClient';
import {
	DEFAULT_SCRAPE_SUMMARY,
	isCleanPageStatus,
	localInlineFits,
	scrapeHttpErrorStatus,
	SCRAPE_INLINE_MAX_CHARS,
	SCRAPE_STORAGE_TTL_MS,
	SCRAPE_TIMEOUT_MS,
	summaryFitsTransport,
	type ScrapedPage
} from '@convex/webTools';
import { initConvexTest, seedStartedWebJob, type ConvexTestInstance } from './test.setup';

const PAGE_URL = 'https://example.com/page';
const AUDIO_URL = 'https://storage.googleapis.com/scrape/audio.mp3?X-Goog-Signature=sig';
const VIDEO_URL = 'https://storage.googleapis.com/scrape/video.mp4?X-Goog-Signature=sig';

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
		audio?: string;
		video?: string;
		metadata?: { sourceURL?: string; url?: string; statusCode?: number };
	},
	url = PAGE_URL
) {
	return vi.spyOn(FirecrawlClient.prototype, 'scrape').mockResolvedValue({
		markdown: document.markdown,
		summary: document.summary,
		images: document.images,
		audio: document.audio,
		video: document.video,
		metadata: document.metadata ?? { sourceURL: url, statusCode: 200 }
	});
}

function expectedScrapeArgs(url = PAGE_URL) {
	return [
		expect.anything(),
		url,
		{
			formats: ['markdown', 'summary', 'images', 'audio', 'video'],
			onlyMainContent: true,
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
	it('reads Firecrawl API errors from ConvexError data', () => {
		expect(scrapeHttpErrorStatus(firecrawlApiError(404))).toBe(404);
		expect(scrapeHttpErrorStatus(firecrawlApiError(429))).toBe(429);
	});

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

	it('ignores non-HTTP and malformed errors', () => {
		expect(scrapeHttpErrorStatus(new Error('{"status":200}'))).toBeUndefined();
		expect(scrapeHttpErrorStatus(new Error('Firecrawl scrape timed out after 60000ms.'))).toBe(
			undefined
		);
	});

	it('does not treat page metadata.statusCode as a Firecrawl API error', () => {
		expect(scrapeHttpErrorStatus(new Error('This webpage returned a 404 error.'))).toBeUndefined();
		expect(isCleanPageStatus(404)).toBe(false);
		expect(isCleanPageStatus(200)).toBe(true);
		expect(isCleanPageStatus(304)).toBe(true);
		expect(isCleanPageStatus(301)).toBe(false);
	});
});

describe('scrapeForTool auth', () => {
	it('scrapes the URL from the authorized job payload with the Firecrawl formats', async () => {
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
				await asUser.action(api.webTools.scrapeForTool, {
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

	it('keeps the retired scrapeUrl action', async () => {
		const t = initConvexTest();
		const { asUser, runId, claimId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'retired-scrape-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com' }
		});
		await expect(
			asUser.action(api.webTools.scrapeUrl, {
				url: 'https://example.com',
				runId,
				claimId,
				executionSecret
			})
		).rejects.toThrow(UNSUPPORTED_CLIENT_MESSAGE);
	});

	it('rejects a wrong execution secret', async () => {
		const t = initConvexTest();
		const { asUser, runId, claimId, jobId } = await seedStartedWebJob(t, {
			executionSecret: 'scrape-auth-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});
		await expect(
			asUser.action(api.webTools.scrapeForTool, {
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
			await ctx.db.patch('executorJobs', jobId, { cloudWorkId: 'historical-cloud-work' });
		});
		await expect(
			asUser.action(api.webTools.scrapeForTool, {
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
			asUser.action(api.webTools.scrapeForTool, {
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
			await ctx.db.patch('runs', runId, { claimExpiresAt: Date.now() - 1 });
		});
		await expect(
			asUser.action(api.webTools.scrapeForTool, {
				runId,
				claimId,
				jobId,
				executionSecret
			})
		).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
		expect(
			await t.query(internal.webToolPool.getLocalScrapeJob, {
				runId,
				claimId,
				jobId,
				executionSecret
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
			result: { url: PAGE_URL, markdown: 'done', summary: 'Done.' }
		});
		await expect(
			asUser.action(api.webTools.scrapeForTool, {
				runId,
				claimId,
				jobId,
				executionSecret
			})
		).rejects.toThrow(RUN_NO_LONGER_ACTIVE);
	});
});

describe('stored scrape_url results', () => {
	it('stores scrape results without truncated', async () => {
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
				markdown: 'The scrape was saved to /tmp/scrape.md.'
			}
		});
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job?.result).toEqual({
			url: PAGE_URL,
			markdown: 'The scrape was saved to /tmp/scrape.md.'
		});
		expect(job?.result).not.toHaveProperty('truncated');
		expect(job?.result).not.toHaveProperty('summary');
	});

	it('still accepts stored scrape results with truncated', async () => {
		const t = initConvexTest();
		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'legacy-truncated-secret',
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
				truncated: true
			}
		});
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job?.result).toEqual({
			url: PAGE_URL,
			markdown: 'partial',
			truncated: true
		});
	});

	it('accepts stored scrape results with additive summary and media', async () => {
		const t = initConvexTest();
		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'saved-media-secret',
			kind: 'scrape_url',
			payload: { url: PAGE_URL }
		});
		const result = {
			url: PAGE_URL,
			markdown: '# Page',
			summary: 'A page.',
			images: ['https://example.com/a.png'],
			audio: AUDIO_URL,
			video: VIDEO_URL
		};
		await asUser.mutation(api.executor.complete, {
			runId,
			claimId,
			executionSecret,
			jobId,
			result
		});
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job?.result).toEqual(result);
	});
});

async function scrapeLocalPage(
	document: {
		markdown?: string;
		summary?: string;
		images?: string[];
		audio?: string;
		video?: string;
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
		const result = await seeded.asUser.action(api.webTools.scrapeForTool, {
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
	it('keeps short markdown plus media inline', () => {
		expect(
			localInlineFits({
				url: PAGE_URL,
				markdown: 'x'.repeat(SCRAPE_INLINE_MAX_CHARS - 1_000),
				summary: 'Short page.',
				images: ['https://example.com/a.png'],
				audio: AUDIO_URL,
				video: VIDEO_URL
			})
		).toBe(true);
	});

	it('spills when the images list alone exceeds the document budget', () => {
		const page: ScrapedPage = {
			url: PAGE_URL,
			markdown: 'short',
			summary: 'Short page.',
			images: [`https://cdn.example.com/${'x'.repeat(SCRAPE_INLINE_MAX_CHARS)}.png`]
		};
		expect(localInlineFits(page)).toBe(false);
		expect(summaryFitsTransport(page)).toBe(true);
	});

	it('spills at the inline limit even when markdown alone fits', () => {
		const page: ScrapedPage = { url: PAGE_URL, markdown: '', summary: 'Summary', images: [] };
		page.markdown = 'x'.repeat(SCRAPE_INLINE_MAX_CHARS - JSON.stringify(page).length);
		expect(localInlineFits(page)).toBe(true);
		page.images.push('https://example.com/a.png');
		expect(localInlineFits(page)).toBe(false);
	});

	it('spills image arrays that exceed Convex array limits', () => {
		expect(
			localInlineFits({
				url: PAGE_URL,
				markdown: '',
				summary: 'Summary',
				images: Array(8_193).fill('')
			})
		).toBe(false);
	});

	it('rejects a summary that cannot fit the inline budget', async () => {
		const page: ScrapedPage = {
			url: PAGE_URL,
			markdown: 'hi',
			summary: 's'.repeat(SCRAPE_INLINE_MAX_CHARS),
			images: []
		};
		expect(summaryFitsTransport(page)).toBe(false);
		await expect(scrapeLocalPage(page)).rejects.toThrow('Scrape summary is too large.');
	});
});

describe('scrapeForTool markdown transport', () => {
	it.each([undefined, 'json'] as const)(
		'rejects oversized %s archives without storing a blob',
		async (archiveFormat) => {
			const t = initConvexTest();
			const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
				executionSecret: 'oversized-markdown-secret',
				kind: 'scrape_url',
				payload: { url: 'https://example.com/page' }
			});
			const scrape = mockScrape({ markdown: `${'é'.repeat(32 * 1024 * 1024)}x` });
			try {
				await expect(
					asUser.action(api.webTools.scrapeForTool, {
						runId,
						claimId,
						jobId,
						executionSecret,
						archiveFormat
					})
				).rejects.toThrow('Scrape exceeds the 64 MiB download limit.');
				expect(await storageBlobs(t)).toEqual([]);
			} finally {
				scrape.mockRestore();
			}
		}
	);

	it('counts JSON escaping toward the receiver byte limit', async () => {
		await expect(
			scrapeLocalPage({ markdown: '\n'.repeat(32 * 1024 * 1024), summary: 'Summary' })
		).rejects.toThrow('Scrape exceeds the 64 MiB download limit.');
	});

	it('accepts raw markdown exactly at the receiver byte limit', async () => {
		const { t, result } = await scrapeLocalPage(
			{ markdown: 'é'.repeat(32 * 1024 * 1024) },
			PAGE_URL,
			null
		);
		expect(result).toHaveProperty('markdownUrl');
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		expect(blobs[0]?.size).toBe(64 * 1024 * 1024);
	});

	it('accepts a JSON archive exactly at the receiver byte limit', async () => {
		const page: ScrapedPage = { url: PAGE_URL, markdown: '', summary: 'Summary', images: [] };
		page.markdown = 'x'.repeat(64 * 1024 * 1024 - JSON.stringify(page).length);
		const { t, result } = await scrapeLocalPage(page);
		expect(result).toHaveProperty('scrapeUrl');
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		expect(blobs[0]?.size).toBe(64 * 1024 * 1024);
	});

	it('returns short markdown, summary, and media inline without truncated or storage', async () => {
		const markdown = 'x'.repeat(SCRAPE_INLINE_MAX_CHARS - 1_000);
		const { t, result, scrapeCalls } = await scrapeLocalPage({
			markdown,
			summary: 'A long but inline page.',
			images: ['https://example.com/a.png'],
			audio: AUDIO_URL,
			video: VIDEO_URL
		});
		expect(result).toEqual({
			url: PAGE_URL,
			markdown,
			summary: 'A long but inline page.',
			images: ['https://example.com/a.png'],
			audio: AUDIO_URL,
			video: VIDEO_URL
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

	it('stores the full scrape JSON including all media and returns scrapeUrl', async () => {
		const markdown = `${'x'.repeat(SCRAPE_INLINE_MAX_CHARS)}é`;
		const images = ['https://example.com/a.png', 'https://example.com/b.png'];
		const archive = {
			url: PAGE_URL,
			markdown,
			summary: 'Huge page.',
			images,
			audio: AUDIO_URL,
			video: VIDEO_URL
		};
		const expectedBytes = new TextEncoder().encode(JSON.stringify(archive));
		const { t, result, scrapeCalls } = await scrapeLocalPage({
			markdown,
			summary: 'Huge page.',
			images,
			audio: AUDIO_URL,
			video: VIDEO_URL
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
				asUser.action(api.webTools.scrapeForTool, {
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
				asUser.action(api.webTools.scrapeForTool, {
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
				asUser.action(api.webTools.scrapeForTool, {
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
				asUser.action(api.webTools.scrapeForTool, {
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

