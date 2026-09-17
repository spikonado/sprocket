import { describe, expect, it, vi } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';
import { INBOX_WORKING_MIGRATION } from './lib/inboxState';
import { AUTOMATIC_CLEANUP_DELAY_MS } from './migrations';

const oneBatch = { cursor: null, dryRun: false, oneBatchOnly: true } as const;

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
				fastMode: false,
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

	it('removes fields and tables retained for the rolling deployment', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const ids = await t.run(async (ctx) => {
			const projectId = await ctx.db.insert('projects', {
				userId: 'user_alice',
				repositoryKey: 'alpha',
				displayName: 'Alpha',
				nextExecutorSequence: 1,
				lastSeenAt: 1
			});
			const connectionId = await ctx.db.insert('projectConnections', {
				projectId,
				userId: 'user_alice',
				clientId: 'legacy-client',
				lastHeartbeatAt: 1
			});
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.unique();
			const usage = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (!run || !usage) throw new Error('Missing test fixture.');
			await ctx.db.patch('threadRecords', threadId, { projectId });
			await ctx.db.patch('runs', run._id, {
				projectId,
				catalogVersion: 'legacy-catalog',
				completionTransport: 'convex-action',
				contextWindowTokens: 100_000,
				autoCompactTokenLimit: 80_000,
				promptMessageId: 'legacy-prompt'
			});
			await ctx.db.patch('threadUsage', usage._id, {
				totalTokensProcessed: 42,
				usageLedgerMigratedAt: 1
			});
			const transcriptStateId = await ctx.db.insert('threadTranscriptStates', {
				threadId,
				userId: 'user_alice',
				totalParts: 1,
				migratedAt: 1
			});
			const storageId = await ctx.storage.store(new Blob(['legacy-image']));
			const uploadId = await ctx.db.insert('imageUploads', {
				userId: 'user_alice',
				storageId,
				name: 'legacy.png',
				mediaType: 'image/png',
				size: 1,
				messageIds: ['legacy-message'],
				attached: true,
				threadId
			});
			const jobId = await ctx.db.insert('executorJobs', {
				threadId,
				runId: run._id,
				projectId,
				kind: 'web_search',
				payload: { query: 'compatibility' },
				hidden: false,
				status: 'pending',
				enqueuedAt: 1,
				sequence: 0,
				cloudWorkPool: 'firecrawlScrape'
			});
			return {
				projectId,
				connectionId,
				runId: run._id,
				usageId: usage._id,
				transcriptStateId,
				uploadId,
				jobId
			};
		});

		for (const migration of [
			internal.migrations.removeThreadRecordProjectId,
			internal.migrations.removeRunCompletionTransport,
			internal.migrations.removeRunLegacyFields,
			internal.migrations.removeThreadUsageLegacyFields,
			internal.migrations.removeTranscriptStateMigratedAt,
			internal.migrations.removeImageUploadMessageIds,
			internal.migrations.removeExecutorJobCloudWorkPool,
			internal.migrations.removeExecutorJobProjectId,
			internal.migrations.deleteProjectConnections,
			internal.migrations.deleteProjects
		]) {
			await t.mutation(migration, oneBatch);
		}

		const migrated = await t.run(async (ctx) => ({
			thread: await ctx.db.get('threadRecords', threadId),
			run: await ctx.db.get('runs', ids.runId),
			usage: await ctx.db.get('threadUsage', ids.usageId),
			transcriptState: await ctx.db.get('threadTranscriptStates', ids.transcriptStateId),
			upload: await ctx.db.get('imageUploads', ids.uploadId),
			job: await ctx.db.get('executorJobs', ids.jobId),
			project: await ctx.db.get('projects', ids.projectId),
			connection: await ctx.db.get('projectConnections', ids.connectionId)
		}));
		expect(migrated.thread?.projectId).toBeUndefined();
		expect(migrated.run).not.toHaveProperty('completionTransport');
		expect(migrated.run).not.toHaveProperty('projectId');
		expect(migrated.run).not.toHaveProperty('catalogVersion');
		expect(migrated.run).not.toHaveProperty('contextWindowTokens');
		expect(migrated.run).not.toHaveProperty('autoCompactTokenLimit');
		expect(migrated.run).not.toHaveProperty('promptMessageId');
		expect(migrated.usage).not.toHaveProperty('totalTokensProcessed');
		expect(migrated.usage).not.toHaveProperty('usageLedgerMigratedAt');
		expect(migrated.transcriptState).not.toHaveProperty('migratedAt');
		expect(migrated.upload).not.toHaveProperty('messageIds');
		expect(migrated.job).not.toHaveProperty('cloudWorkPool');
		expect(migrated.job).not.toHaveProperty('projectId');
		expect(migrated.project).toBeNull();
		expect(migrated.connection).toBeNull();
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
				await ctx.db.patch('runs', run._id, { status: 'failed', completionTransport: 'gateway' });
				return run._id;
			});

			await t.mutation(internal.migrations.runProductionRolloutCleanupAutomatically, {});
			const schedule = await t.run((ctx) =>
				ctx.db.query('migrationSchedules').withIndex('by_name').unique()
			);
			expect(schedule).toMatchObject({ notBefore: deployedAt + AUTOMATIC_CLEANUP_DELAY_MS });
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

describe('inbox working migration', () => {
	it('backfills missing and stale working flags from thread status', async () => {
		const t = initConvexTest();
		const ids = await t.run(async (ctx) => {
			const insertThread = async (
				submissionId: string,
				status?: 'queued' | 'running' | 'completed',
				working?: boolean
			) => {
				const threadId = await ctx.db.insert('threadRecords', {
					userId: 'user_alice',
					submissionId,
					repositoryKey: 'alpha',
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					fastMode: false,
					lastMessageAt: 1
				});
				if (status !== undefined) await ctx.db.patch('threadRecords', threadId, { status });
				if (working !== undefined) await ctx.db.patch('threadRecords', threadId, { working });
				return threadId;
			};
			return {
				missingQueued: await insertThread('missing-queued', 'queued'),
				missingRunning: await insertThread('missing-running', 'running'),
				missingCompleted: await insertThread('missing-completed', 'completed'),
				missingStatus: await insertThread('missing-status'),
				wrongIdle: await insertThread('wrong-idle', 'completed', true),
				alreadyWorking: await insertThread('already-working', 'queued', true)
			};
		});

		await t.mutation(internal.migrations.backfillInboxWorking, oneBatch);

		const records = await t.run(async (ctx) => ({
			missingQueued: await ctx.db.get('threadRecords', ids.missingQueued),
			missingRunning: await ctx.db.get('threadRecords', ids.missingRunning),
			missingCompleted: await ctx.db.get('threadRecords', ids.missingCompleted),
			missingStatus: await ctx.db.get('threadRecords', ids.missingStatus),
			wrongIdle: await ctx.db.get('threadRecords', ids.wrongIdle),
			alreadyWorking: await ctx.db.get('threadRecords', ids.alreadyWorking)
		}));
		expect(records.missingQueued?.working).toBe(true);
		expect(records.missingRunning?.working).toBe(true);
		expect(records.missingCompleted?.working).toBe(false);
		expect(records.missingStatus?.working).toBe(false);
		expect(records.wrongIdle?.working).toBe(false);
		expect(records.alreadyWorking?.working).toBe(true);
	});

	it('marks the inbox working schedule complete and skips a second run', async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t);
			await t.run(async (ctx) => {
				await ctx.db.patch('threadRecords', threadId, {
					status: 'queued',
					working: undefined
				});
			});

			await t.mutation(internal.migrations.runInboxWorkingMigration, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);

			const first = await t.run(async (ctx) => ({
				thread: await ctx.db.get('threadRecords', threadId),
				schedule: await ctx.db
					.query('migrationSchedules')
					.withIndex('by_name', (q) => q.eq('name', INBOX_WORKING_MIGRATION))
					.unique()
			}));
			expect(first.thread?.working).toBe(true);
			expect(first.schedule?.startedAt).toBeDefined();
			expect(first.schedule?.completedAt).toBeDefined();

			await t.run(async (ctx) => {
				await ctx.db.patch('threadRecords', threadId, { status: 'completed', working: true });
			});
			await t.mutation(internal.migrations.runInboxWorkingMigration, {});
			expect((await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.working).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
