import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('schema rollout compatibility', () => {
	it('accepts rows retained from production before cleanup', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const legacy = await t.run(async (ctx) => {
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

			await ctx.db.patch('threadRecords', threadId, { status: undefined, projectId });
			await ctx.db.patch('runs', run._id, {
				projectId,
				catalogVersion: 'legacy-catalog',
				completionTransport: 'gateway',
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
				thread: await ctx.db.get('threadRecords', threadId),
				run: await ctx.db.get('runs', run._id),
				usage: await ctx.db.get('threadUsage', usage._id),
				transcriptState: await ctx.db.get('threadTranscriptStates', transcriptStateId),
				upload: await ctx.db.get('imageUploads', uploadId),
				job: await ctx.db.get('executorJobs', jobId),
				project: await ctx.db.get('projects', projectId),
				connection: await ctx.db.get('projectConnections', connectionId)
			};
		});

		expect(legacy.thread?.status).toBeUndefined();
		expect(legacy.thread?.projectId).toBe(legacy.project?._id);
		expect(legacy.run).toMatchObject({
			projectId: legacy.project?._id,
			catalogVersion: 'legacy-catalog',
			completionTransport: 'gateway',
			contextWindowTokens: 100_000,
			autoCompactTokenLimit: 80_000,
			promptMessageId: 'legacy-prompt'
		});
		expect(legacy.usage).toMatchObject({ totalTokensProcessed: 42, usageLedgerMigratedAt: 1 });
		expect(legacy.transcriptState?.migratedAt).toBe(1);
		expect(legacy.upload?.messageIds).toEqual(['legacy-message']);
		expect(legacy.job).toMatchObject({
			projectId: legacy.project?._id,
			cloudWorkPool: 'firecrawlScrape'
		});
		expect(legacy.connection?.projectId).toBe(legacy.project?._id);

		await expect(asUser.mutation(api.threads.archiveForLocalCache, { threadId })).resolves.toEqual({
			userId: legacy.thread?.userId,
			repositoryKey: legacy.thread?.repositoryKey
		});
	});
});
