import { describe, expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest } from './test.setup';

describe('thread status migration', () => {
	it('backfills status from the latest run', async () => {
		const t = initConvexTest();
		const threadId = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('threadRecords', {
				userId: 'user_alice',
				submissionId: 'thread-submission',
				repositoryKey: 'alpha',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				lastMessageAt: 2
			});
			for (const [submissionId, status, startedAt] of [
				['older-run', 'completed', 1],
				['latest-run', 'running', 2]
			] as const) {
				await ctx.db.insert('runs', {
					threadId,
					userId: 'user_alice',
					submissionId,
					status,
					executionSecretHash: 'fixture',
					completionAttemptSeq: 0,
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					serviceTier: 'standard',
					startedAt
				});
			}
			return threadId;
		});

		await t.mutation(internal.migrations.backfillThreadStatus, {
			cursor: null,
			dryRun: false,
			oneBatchOnly: true
		});

		expect(await t.run(async (ctx) => await ctx.db.get('threadRecords', threadId))).toMatchObject({
			status: 'running'
		});
	});

	it('deletes runless threads and their usage rows', async () => {
		const t = initConvexTest();
		const { threadId, usageId } = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('threadRecords', {
				userId: 'user_alice',
				submissionId: 'runless-submission',
				repositoryKey: 'alpha',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				lastMessageAt: 1
			});
			const usageId = await ctx.db.insert('threadUsage', {
				threadId,
				userId: 'user_alice',
				totalTokensProcessed: 0
			});
			return { threadId, usageId };
		});

		await t.mutation(internal.migrations.backfillThreadStatus, {
			cursor: null,
			dryRun: false,
			oneBatchOnly: true
		});

		const migrated = await t.run(async (ctx) => ({
			thread: await ctx.db.get('threadRecords', threadId),
			usage: await ctx.db.get('threadUsage', usageId)
		}));
		expect(migrated.thread).toBeNull();
		expect(migrated.usage).toBeNull();
	});
});
