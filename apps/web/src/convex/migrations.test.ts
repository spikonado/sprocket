import { describe, expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

const oneBatch = {
	cursor: null,
	dryRun: false,
	oneBatchOnly: true
} as const;

describe('production rollout cleanup migrations', () => {
	it('backfills thread status from the latest run and preserves runless threads', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const runlessThreadId = await t.run(async (ctx) => {
			const latestRun = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.order('desc')
				.first();
			if (!latestRun) throw new Error('Missing test fixture.');
			await ctx.db.patch('runs', latestRun._id, { status: 'failed' });
			await ctx.db.patch('threadRecords', threadId, { status: undefined });
			return await ctx.db.insert('threadRecords', {
				userId: 'user_alice',
				submissionId: 'runless-thread',
				repositoryKey: 'alpha',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				lastMessageAt: 1
			});
		});

		await t.mutation(internal.migrations.backfillMissingThreadStatus, oneBatch);

		const records = await t.run(async (ctx) => ({
			withRun: await ctx.db.get('threadRecords', threadId),
			runless: await ctx.db.get('threadRecords', runlessThreadId)
		}));
		expect(records.withRun?.status).toBe('failed');
		expect(records.runless?.status).toBe('completed');
	});

	it('unsets fields retained for the rolling deployment', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const ids = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.unique();
			const usage = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (!run || !usage) throw new Error('Missing test fixture.');
			await ctx.db.patch('runs', run._id, { completionTransport: 'convex-action' });
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
			return { runId: run._id, usageId: usage._id, jobId };
		});

		await t.mutation(internal.migrations.removeRunCompletionTransport, oneBatch);
		await t.mutation(internal.migrations.removeThreadUsageLegacyFields, oneBatch);
		await t.mutation(internal.migrations.removeExecutorJobCloudWorkPool, oneBatch);

		const migrated = await t.run(async (ctx) => ({
			run: await ctx.db.get('runs', ids.runId),
			usage: await ctx.db.get('threadUsage', ids.usageId),
			job: await ctx.db.get('executorJobs', ids.jobId)
		}));
		expect(migrated.run?.completionTransport).toBeUndefined();
		expect(migrated.usage?.totalTokensProcessed).toBeUndefined();
		expect(migrated.usage?.usageLedgerMigratedAt).toBeUndefined();
		expect(migrated.job?.cloudWorkPool).toBeUndefined();
	});
});
