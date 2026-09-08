import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextDev } from '@context-dot-dev/convex';
import { api, internal } from '@convex/_generated/api';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { UNSUPPORTED_CLIENT_MESSAGE } from '@convex/lib/unsupportedClient';
import {
	isUnparseablePageFailure,
	scrapeHttpErrorStatus,
	SCRAPE_MARKDOWN_MAX_CHARS,
	SCRAPE_MARKDOWN_STORAGE_TTL_MS
} from '@convex/webTools';
import { initConvexTest, seedStartedWebJob, type ConvexTestInstance } from './test.setup';

function mockScrapeMarkdown(markdown: string, url = 'https://example.com/page') {
	return vi.spyOn(ContextDev.prototype, 'scrapeMarkdown').mockResolvedValue({
		success: true,
		url,
		markdown,
		metadata: { sourceUrl: url, finalUrl: url }
	});
}

async function storageBlobs(t: ConvexTestInstance) {
	return await t.run(async (ctx) => ctx.db.system.query('_storage').collect());
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('scrape HTTP failures', () => {
	it('turns a Context.dev HTTP error into a readable message', () => {
		const error = new Error(
			'Uncaught ConvexError: Uncaught ConvexError: {"message":"Target page returned a 404","status":404,"response":{"error_code":"NOT_FOUND"}}\n    at contextRequest (http.js:24:12)'
		);
		expect(scrapeHttpErrorStatus(error)).toBe(404);
	});

	it('ignores non-HTTP and malformed errors', () => {
		expect(scrapeHttpErrorStatus(new Error('{"status":200}'))).toBeUndefined();
		expect(scrapeHttpErrorStatus(new Error('Context.dev scrape failed.'))).toBeUndefined();
	});
});

describe('unparseable page failures', () => {
	it('recognizes component return-validation failures', () => {
		const error = new Error(
			'Uncaught ConvexError: ReturnsValidationError: Value does not match validator. Path: .values()'
		);
		expect(isUnparseablePageFailure(error)).toBe(true);
	});

	it('leaves timeouts and other failures alone', () => {
		expect(isUnparseablePageFailure(new Error('Context.dev scrape timed out after 60000ms.'))).toBe(
			false
		);
		expect(isUnparseablePageFailure(new Error('Run is no longer active.'))).toBe(false);
	});
});

describe('scrapeForTool auth', () => {
	it('scrapes the URL from the authorized job payload', async () => {
		const t = initConvexTest();
		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'local-scrape-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/page' }
		});
		const scrape = mockScrapeMarkdown('# Page');
		try {
			expect(
				await asUser.action(api.webTools.scrapeForTool, {
					runId,
					claimId,
					jobId,
					executionSecret
				})
			).toEqual({ url: 'https://example.com/page', markdown: '# Page' });
			expect(scrape).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					params: expect.objectContaining({ url: 'https://example.com/page' })
				})
			);
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
			payload: { url: 'https://example.com/page' }
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
			payload: { url: 'https://example.com/page' }
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
			payload: { url: 'https://example.com/page' }
		});
		await asUser.mutation(api.executor.complete, {
			runId,
			claimId,
			executionSecret,
			jobId,
			result: { url: 'https://example.com/page', markdown: 'done' }
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
			payload: { url: 'https://example.com/page' },
			localExecution: true
		});
		await asUser.mutation(api.executor.complete, {
			runId,
			claimId,
			executionSecret,
			jobId,
			result: {
				url: 'https://example.com/page',
				markdown: 'The scrape was saved to /tmp/scrape.md.'
			}
		});
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job?.result).toEqual({
			url: 'https://example.com/page',
			markdown: 'The scrape was saved to /tmp/scrape.md.'
		});
		expect(job?.result).not.toHaveProperty('truncated');
	});

	it('still accepts stored scrape results with truncated', async () => {
		const t = initConvexTest();
		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'legacy-truncated-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/page' },
			localExecution: true
		});
		await asUser.mutation(api.executor.complete, {
			runId,
			claimId,
			executionSecret,
			jobId,
			result: {
				url: 'https://example.com/page',
				markdown: 'partial',
				truncated: true
			}
		});
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job?.result).toEqual({
			url: 'https://example.com/page',
			markdown: 'partial',
			truncated: true
		});
	});
});

async function scrapeLocalMarkdown(markdown: string, url = 'https://example.com/page') {
	const t = initConvexTest();
	const seeded = await seedStartedWebJob(t, {
		executionSecret: `local-md-${Math.random()}`,
		kind: 'scrape_url',
		payload: { url },
		localExecution: true
	});
	const scrape = mockScrapeMarkdown(markdown, url);
	try {
		const result = await seeded.asUser.action(api.webTools.scrapeForTool, {
			runId: seeded.runId,
			claimId: seeded.claimId,
			jobId: seeded.jobId,
			executionSecret: seeded.executionSecret
		});
		return { t, result, scrapeCalls: scrape.mock.calls.length };
	} finally {
		scrape.mockRestore();
	}
}

describe('scrapeForTool markdown transport', () => {
	it('rejects markdown above the receiver byte limit without storing a blob', async () => {
		const t = initConvexTest();
		const { asUser, runId, claimId, jobId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'oversized-markdown-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/page' },
			localExecution: true
		});
		const scrape = mockScrapeMarkdown(`${'é'.repeat(32 * 1024 * 1024)}x`);
		try {
			await expect(
				asUser.action(api.webTools.scrapeForTool, { runId, claimId, jobId, executionSecret })
			).rejects.toThrow('Scrape exceeds the 64 MiB download limit.');
			expect(await storageBlobs(t)).toEqual([]);
		} finally {
			scrape.mockRestore();
		}
	});

	it('accepts markdown exactly at the receiver byte limit', async () => {
		const { t, result } = await scrapeLocalMarkdown('é'.repeat(32 * 1024 * 1024));
		expect(result).toHaveProperty('markdownUrl');
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		expect(blobs[0]?.size).toBe(64 * 1024 * 1024);
	});

	it('returns short markdown inline without truncated or storage', async () => {
		const markdown = 'x'.repeat(SCRAPE_MARKDOWN_MAX_CHARS);
		const { t, result, scrapeCalls } = await scrapeLocalMarkdown(markdown);
		expect(result).toEqual({ url: 'https://example.com/page', markdown });
		expect(result).not.toHaveProperty('truncated');
		expect(result).not.toHaveProperty('markdownUrl');
		expect(scrapeCalls).toBe(1);
		expect(await storageBlobs(t)).toEqual([]);
	});

	it('stores full long markdown bytes and returns markdownUrl', async () => {
		const markdown = `${'x'.repeat(SCRAPE_MARKDOWN_MAX_CHARS)}é`;
		const expectedBytes = new TextEncoder().encode(markdown);
		const { t, result, scrapeCalls } = await scrapeLocalMarkdown(markdown);
		expect(result).toEqual({
			url: 'https://example.com/page',
			markdownUrl: expect.any(String)
		});
		expect(result).not.toHaveProperty('truncated');
		expect(result).not.toHaveProperty('markdown');
		expect(scrapeCalls).toBe(1);
		if (!('markdownUrl' in result)) throw new Error('expected markdownUrl');
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		expect(blobs[0]?.size).toBe(expectedBytes.byteLength);
		const storedUrl = await t.run(async (ctx) => {
			if (!blobs[0]) return null;
			return await ctx.storage.getUrl(blobs[0]._id);
		});
		expect(storedUrl).toBe(result.markdownUrl);
	});

	it('deletes stored markdown after one hour', async () => {
		const markdown = `${'x'.repeat(SCRAPE_MARKDOWN_MAX_CHARS)}y`;
		const { t } = await scrapeLocalMarkdown(markdown);
		const blobs = await storageBlobs(t);
		expect(blobs).toHaveLength(1);
		const storageId = blobs[0]?._id;
		expect(storageId).toBeDefined();
		await t.finishAllScheduledFunctions(() => {
			vi.advanceTimersByTime(SCRAPE_MARKDOWN_STORAGE_TTL_MS);
		});
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId!))).toBeNull();
	});
});
