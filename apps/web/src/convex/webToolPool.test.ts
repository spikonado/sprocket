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

	it('reads historical truncated scrape results', async () => {
		const t = initConvexTest();
		const { jobId } = await seedStartedWebJob(t, {
			executionSecret: 'webpool-scrape-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/legacy' },
			localExecution: true
		});
		const markdown = 'x'.repeat(40_000);
		await t.run(async (ctx) => {
			await ctx.db.patch('executorJobs', jobId, {
				status: 'completed',
				result: { url: 'https://example.com/legacy', markdown, truncated: true }
			});
		});
		const after = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(after?.status).toBe('completed');
		expect(after?.result).toEqual({
			url: 'https://example.com/legacy',
			markdown,
			truncated: true
		});
	});
});

describe('local scrape_url dispatch', () => {
	it('dispatches scrape_url locally without an execution-mode flag', async () => {
		const t = initConvexTest();
		const { jobId, runId, claimId, executionSecret } = await seedStartedWebJob(t, {
			executionSecret: 'local-scrape-secret',
			kind: 'scrape_url',
			payload: { url: 'https://example.com/page' }
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

	it('dispatches web_search through the cloud workpool', async () => {
		const t = initConvexTest();
		const { jobId } = await seedStartedWebJob(t, {
			executionSecret: 'local-search-secret',
			kind: 'web_search',
			payload: { query: 'sprocket' }
		});
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(stored?.cloudWorkId).toEqual(expect.any(String));
	});
});

describe('temporary scrape storage', () => {
	it('deletes unregistered blobs and is a no-op after they are gone', async () => {
		const t = initConvexTest();
		const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(['scrape markdown'])));
		expect(await t.mutation(internal.webToolPool.deleteTemporaryStorage, { storageId })).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).toBeNull();
		expect(await t.mutation(internal.webToolPool.deleteTemporaryStorage, { storageId })).toBeNull();
	});

	it('leaves registered attachments in place', async () => {
		const t = initConvexTest();
		const storageId = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['attached']));
			await ctx.db.insert('imageUploads', {
				userId: 'owner',
				storageId,
				name: 'file.txt',
				mediaType: 'text/plain',
				size: 8,
				attached: true
			});
			return storageId;
		});
		expect(await t.mutation(internal.webToolPool.deleteTemporaryStorage, { storageId })).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageId))).not.toBeNull();
	});
});
