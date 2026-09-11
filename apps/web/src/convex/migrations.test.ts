import { describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';
import { AUTOMATIC_CLEANUP_DELAY_MS } from './migrations';

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

	it('waits for prior writers and then runs the cleanup automatically', async () => {
		vi.useFakeTimers();
		const deployedAt = Date.UTC(2026, 8, 11);
		vi.setSystemTime(deployedAt);
		try {
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t);
			const runId = await t.run(async (ctx) => {
				const run = await ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
					.unique();
				if (!run) throw new Error('Missing test fixture.');
				await ctx.db.patch('threadRecords', threadId, { status: undefined });
				await ctx.db.patch('runs', run._id, {
					status: 'failed',
					completionTransport: 'gateway'
				});
				return run._id;
			});

			await t.mutation(internal.migrations.runProductionRolloutCleanupAutomatically, {});
			const schedule = await t.run((ctx) =>
				ctx.db.query('migrationSchedules').withIndex('by_name').unique()
			);
			expect(schedule).toMatchObject({
				notBefore: deployedAt + AUTOMATIC_CLEANUP_DELAY_MS
			});
			expect(schedule?.startedAt).toBeUndefined();

			vi.setSystemTime(deployedAt + AUTOMATIC_CLEANUP_DELAY_MS - 1);
			await t.mutation(internal.migrations.runProductionRolloutCleanupAutomatically, {});
			expect((await t.run((ctx) => ctx.db.get('runs', runId)))?.completionTransport).toBe(
				'gateway'
			);

			vi.setSystemTime(deployedAt + AUTOMATIC_CLEANUP_DELAY_MS);
			await t.mutation(internal.migrations.runProductionRolloutCleanupAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.runProductionRolloutCleanupAutomatically, {});

			const migrated = await t.run(async (ctx) => ({
				schedule: await ctx.db.query('migrationSchedules').withIndex('by_name').unique(),
				thread: await ctx.db.get('threadRecords', threadId),
				run: await ctx.db.get('runs', runId)
			}));
			expect(migrated.schedule?.startedAt).toBeDefined();
			expect(migrated.schedule?.completedAt).toBeDefined();
			expect(migrated.thread?.status).toBe('failed');
			expect(migrated.run?.completionTransport).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
