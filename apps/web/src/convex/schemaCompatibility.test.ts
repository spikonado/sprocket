import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('schema rollout compatibility', () => {
	it('accepts rows written by the previous production deployment', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const legacy = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.unique();
			const usage = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (!run || !usage) throw new Error('Missing test fixture.');

			await ctx.db.patch('threadRecords', threadId, { status: undefined });
			await ctx.db.patch('runs', run._id, { completionTransport: 'gateway' });
			await ctx.db.patch('threadUsage', usage._id, {
				totalTokensProcessed: 42,
				usageLedgerMigratedAt: 1
			});
			const jobId = await ctx.db.insert('executorJobs', {
				threadId,
				runId: run._id,
				kind: 'web_search',
				payload: { query: 'compatibility' },
				hidden: false,
				status: 'pending',
				enqueuedAt: 1,
				sequence: 0,
				cloudWorkPool: 'firecrawlScrape'
			});

			return {
				thread: await ctx.db.get('threadRecords', threadId),
				run: await ctx.db.get('runs', run._id),
				usage: await ctx.db.get('threadUsage', usage._id),
				job: await ctx.db.get('executorJobs', jobId)
			};
		});

		expect(legacy.thread?.status).toBeUndefined();
		expect(legacy.run?.completionTransport).toBe('gateway');
		expect(legacy.usage).toMatchObject({ totalTokensProcessed: 42, usageLedgerMigratedAt: 1 });
		expect(legacy.job?.cloudWorkPool).toBe('firecrawlScrape');

		await expect(asUser.mutation(api.threads.archiveForLocalCache, { threadId })).resolves.toEqual({
			userId: legacy.thread?.userId,
			repositoryKey: legacy.thread?.repositoryKey
		});
	});
});
