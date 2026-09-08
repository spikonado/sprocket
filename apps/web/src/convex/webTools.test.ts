import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextDev } from '@context-dot-dev/convex';
import { api, internal } from '@convex/_generated/api';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';
import { UNSUPPORTED_CLIENT_MESSAGE } from '@convex/lib/unsupportedClient';
import { isUnparseablePageFailure, scrapeHttpErrorStatus } from '@convex/webTools';
import { initConvexTest, seedStartedWebJob } from './test.setup';

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
		const scrape = vi.spyOn(ContextDev.prototype, 'scrapeMarkdown').mockResolvedValue({
			success: true,
			url: 'https://example.com/page',
			markdown: '# Page',
			metadata: { sourceUrl: 'https://example.com/page', finalUrl: 'https://example.com/page' }
		});
		try {
			expect(
				await asUser.action(api.webTools.scrapeForTool, {
					runId,
					claimId,
					jobId,
					executionSecret
				})
			).toEqual({ url: 'https://example.com/page', markdown: '# Page', truncated: false });
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
			result: { url: 'https://example.com/page', markdown: 'done', truncated: false }
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
