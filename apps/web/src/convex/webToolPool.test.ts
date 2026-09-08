import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedStartedWebJob } from './test.setup';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('web tool workpool fencing', () => {
	it(
		'ignores onComplete callbacks after the owning claim expires',
		{ timeout: 15_000 },
		async () => {
			const t = initConvexTest();
			const { runId, claimId, jobId } = await seedStartedWebJob(t, {
				executionSecret: 'webpool-secret',
				kind: 'web_search',
				payload: { query: 'sprocket' }
			});
			const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
			expect(stored?.cloudWorkId).toEqual(expect.any(String));

			await t.run(async (ctx) => {
				await ctx.db.patch('runs', runId, { claimExpiresAt: Date.now() - 1 });
			});
			await t.mutation(internal.webToolPool.completeWebTool, {
				// SAFETY: Workpool onComplete only uses workId for its own bookkeeping.
				workId: (stored?.cloudWorkId ?? 'work') as WorkId,
				context: { jobId, runId, claimId },
				result: { kind: 'success', returnValue: { results: [{ url: 'https://example.com' }] } }
			});
			const after = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
			expect(after?.status).toBe('claimed');
		}
	);

	it('writes the tool result when the claim still owns the job', async () => {
		const t = initConvexTest();
		const { runId, claimId, jobId } = await seedStartedWebJob(t, {
			executionSecret: 'webpool-ok-secret',
			kind: 'web_search',
			payload: { query: 'sprocket' }
		});
		await t.mutation(internal.webToolPool.completeWebTool, {
			// SAFETY: completeWebTool ignores workId and fences on job/claim state.
			workId: 'work-ok' as WorkId,
			context: { jobId, runId, claimId },
			result: { kind: 'success', returnValue: { results: [{ url: 'https://example.com' }] } }
		});
		const after = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(after?.status).toBe('completed');
		expect(after?.result).toMatchObject({ results: [{ url: 'https://example.com' }] });
	});
});

describe('local scrape_url dispatch', () => {
	it('skips cloud enqueue when localExecution is true', async () => {
		const t = initConvexTest();
		const { jobId, runId, claimId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'local-scrape-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/page' },
			localExecution: true
		});
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(stored?.cloudWorkId).toBeUndefined();
		expect(stored?.status).toBe('claimed');

		const local = await t.query(internal.webToolPool.getLocalScrapeJob, {
			runId,
			claimId,
			jobId,
			executionSecret
		});
		expect(local).toEqual({
			kind: 'scrape_url',
			payload: { url: 'https://example.com/page' }
		});
	});

	it('still enqueues scrape_url when localExecution is omitted', async () => {
		const t = initConvexTest();
		const { jobId, runId, claimId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'legacy-scrape-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/legacy' }
		});
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(stored?.cloudWorkId).toEqual(expect.any(String));
		expect(
			await t.query(internal.webToolPool.getLocalScrapeJob, {
				runId,
				claimId,
				jobId,
				executionSecret
			})
		).toBeNull();
	});

	it('still enqueues web_search even when localExecution is true', async () => {
		const t = initConvexTest();
		const { jobId } = await seedStartedWebJob(t, {
			executionSecret: 'local-search-secret',
			kind: 'web_search',
			payload: { query: 'sprocket' },
			localExecution: true
		});
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(stored?.cloudWorkId).toEqual(expect.any(String));
	});
});
