import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';
import { AUTOMATIC_CLEANUP_DELAY_MS } from './migrations';

const oneBatch = {
	cursor: null,
	dryRun: false,
	oneBatchOnly: true
} as const;

describe('completion stream cleanup', () => {
	it('removes pointers before deleting stream state and leaves run data intact', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'stream-cleanup-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'stream-cleanup', executionSecret);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			executionSecret,
			claimId: 'live-claim'
		});
		const before = await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', runId);
			const stateId = await ctx.db.insert('completionStreamStates', {
				runId,
				userId: 'user_alice',
				sequence: 12,
				streamAttemptId: 'old-stream'
			});
			await ctx.db.patch('runs', runId, { completionStreamStateId: stateId });
			return {
				run,
				stateId,
				execution: await ctx.db
					.query('runExecutionStates')
					.withIndex('by_runId', (q) => q.eq('runId', runId))
					.unique()
			};
		});
		const transcript = await asUser.query(api.transcript.getParts, { threadId, numbers: [0] });
		await t.mutation(internal.migrations.removeRunCompletionStreamStateId, oneBatch);
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toEqual(before.run);
		expect(
			await t.run((ctx) => ctx.db.get('completionStreamStates', before.stateId))
		).not.toBeNull();
		await t.mutation(internal.migrations.deleteCompletionStreamStates, oneBatch);
		await t.mutation(internal.migrations.removeRunCompletionStreamStateId, oneBatch);
		await t.mutation(internal.migrations.deleteCompletionStreamStates, oneBatch);
		expect(await t.run((ctx) => ctx.db.get('completionStreamStates', before.stateId))).toBeNull();
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('runExecutionStates')
					.withIndex('by_runId', (q) => q.eq('runId', runId))
					.unique()
			)
		).toEqual(before.execution);
		expect(await asUser.query(api.transcript.getParts, { threadId, numbers: [0] })).toEqual(
			transcript
		);
		await expect(
			asUser.query(api.agentRuntime.completionActor, { runId, executionSecret })
		).resolves.toMatchObject({ claimId: 'live-claim', status: 'running' });
	});

	it('automatically deletes multiple batches including unreferenced rows', async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const { runId } = await createQueuedRun(
				t,
				asUser,
				threadId,
				'stream-batches',
				'stream-batches-secret'
			);
			await t.run(async (ctx) => {
				for (let sequence = 0; sequence < 105; sequence++) {
					const stateId = await ctx.db.insert('completionStreamStates', {
						runId,
						userId: 'user_alice',
						sequence
					});
					if (sequence === 0)
						await ctx.db.patch('runs', runId, { completionStreamStateId: stateId });
				}
			});
			await t.mutation(internal.migrations.runCompletionStreamCleanupAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.runCompletionStreamCleanupAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await t.run((ctx) => ctx.db.get('runs', runId))).not.toHaveProperty(
				'completionStreamStateId'
			);
			expect(await t.run((ctx) => ctx.db.query('completionStreamStates').first())).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('Fast mode backfill', () => {
	it('maps stored service tiers to the Fast mode boolean', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		const runId = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
				.unique();
			if (!run) throw new Error('Missing test fixture.');
			await ctx.db.patch('threadRecords', threadId, {
				fastMode: undefined,
				serviceTier: 'fast'
			});
			await ctx.db.patch('runs', run._id, {
				fastMode: undefined,
				serviceTier: 'standard'
			});
			return run._id;
		});

		await t.mutation(internal.migrations.backfillThreadFastMode, oneBatch);
		await t.mutation(internal.migrations.backfillRunFastMode, oneBatch);

		const migrated = await t.run(async (ctx) => ({
			thread: await ctx.db.get('threadRecords', threadId),
			run: await ctx.db.get('runs', runId)
		}));
		expect(migrated.thread?.fastMode).toBe(true);
		expect(migrated.run?.fastMode).toBe(false);
		expect(migrated.thread).not.toHaveProperty('serviceTier');
		expect(migrated.run).not.toHaveProperty('serviceTier');
	});

	it('runs automatically and records completion', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 8, 12));
		try {
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t);
			await t.run(async (ctx) => {
				await ctx.db.patch('threadRecords', threadId, {
					fastMode: undefined,
					serviceTier: 'fast'
				});
			});

			await t.mutation(internal.migrations.runFastModeBackfillAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.runFastModeBackfillAutomatically, {});

			const result = await t.run(async (ctx) => ({
				thread: await ctx.db.get('threadRecords', threadId),
				schedule: await ctx.db
					.query('migrationSchedules')
					.withIndex('by_name', (query) => query.eq('name', 'fast-mode-backfill-2026-09'))
					.unique()
			}));
			expect(result.thread?.fastMode).toBe(true);
			expect(result.thread).not.toHaveProperty('serviceTier');
			expect(result.schedule?.startedAt).toBeDefined();
			expect(result.schedule?.completedAt).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

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

	it('removes data retained for the rolling deployment', async () => {
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

		await t.mutation(internal.migrations.removeThreadRecordProjectId, oneBatch);
		await t.mutation(internal.migrations.removeRunCompletionTransport, oneBatch);
		await t.mutation(internal.migrations.removeRunLegacyFields, oneBatch);
		await t.mutation(internal.migrations.removeThreadUsageLegacyFields, oneBatch);
		await t.mutation(internal.migrations.removeTranscriptStateMigratedAt, oneBatch);
		await t.mutation(internal.migrations.removeImageUploadMessageIds, oneBatch);
		await t.mutation(internal.migrations.removeExecutorJobCloudWorkPool, oneBatch);
		await t.mutation(internal.migrations.removeExecutorJobProjectId, oneBatch);
		await t.mutation(internal.migrations.deleteProjectConnections, oneBatch);
		await t.mutation(internal.migrations.deleteProjects, oneBatch);

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
		expect(migrated.run?.completionTransport).toBeUndefined();
		expect(migrated.run?.projectId).toBeUndefined();
		expect(migrated.run?.catalogVersion).toBeUndefined();
		expect(migrated.run?.contextWindowTokens).toBeUndefined();
		expect(migrated.run?.autoCompactTokenLimit).toBeUndefined();
		expect(migrated.run?.promptMessageId).toBeUndefined();
		expect(migrated.usage?.totalTokensProcessed).toBeUndefined();
		expect(migrated.usage?.usageLedgerMigratedAt).toBeUndefined();
		expect(migrated.transcriptState?.migratedAt).toBeUndefined();
		expect(migrated.upload?.messageIds).toBeUndefined();
		expect(migrated.job?.cloudWorkPool).toBeUndefined();
		expect(migrated.job?.projectId).toBeUndefined();
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
