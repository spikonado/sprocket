import { describe, expect, it } from 'vitest';
import { absorbDuplicateThread } from './lib/absorbDuplicateThread';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('absorbDuplicateThread', { timeout: 20_000 }, () => {
	it('keeps surviving transcript numbers and does not double-count duplicate usage', async () => {
		const t = initConvexTest();
		const { threadId: keepId, subject } = await seedOwnedThread(t, 'user_alice');
		const ids = await t.run(async (ctx) => {
			const dropId = await ctx.db.insert('threadRecords', {
				userId: subject,
				submissionId: 'dup-submission',
				status: 'completed',
				repositoryKey: 'alpha',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				lastMessageAt: Date.now()
			});
			const keepRun = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', keepId))
				.first();
			if (!keepRun) throw new Error('keep run missing');
			const dropRunId = await ctx.db.insert('runs', {
				userId: subject,
				threadId: dropId,
				submissionId: 'dup-submission-run',
				status: 'completed',
				executionSecretHash: 'fixture',
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				startedAt: Date.now(),
				completedAt: Date.now()
			});
			await ctx.db.insert('threadTranscriptStates', {
				threadId: keepId,
				userId: subject,
				totalParts: 1
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId: keepId,
				userId: subject,
				number: 0,
				sourceKey: 'prompt:shared',
				kind: 'prompt',
				runId: keepRun._id,
				prompt: { text: 'keep' }
			});
			await ctx.db.insert('threadTranscriptStates', {
				threadId: dropId,
				userId: subject,
				totalParts: 2
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId: dropId,
				userId: subject,
				number: 0,
				sourceKey: 'prompt:shared',
				kind: 'prompt',
				runId: dropRunId,
				prompt: { text: 'drop-dup' }
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId: dropId,
				userId: subject,
				number: 1,
				sourceKey: 'completion:unique',
				kind: 'completion',
				runId: dropRunId,
				completion: { text: 'only on drop' }
			});
			const keepUsage = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', keepId))
				.unique();
			if (!keepUsage) throw new Error('keep usage missing');
			await ctx.db.patch('threadUsage', keepUsage._id, { totalTokensProcessed: 10 });
			await ctx.db.insert('threadUsageEvents', {
				threadId: keepId,
				userId: subject,
				eventId: 'usage:shared',
				processedTokens: 10,
				createdAt: Date.now()
			});
			await ctx.db.insert('threadUsage', {
				threadId: dropId,
				userId: subject,
				totalTokensProcessed: 13
			});
			await ctx.db.insert('threadUsageEvents', {
				threadId: dropId,
				userId: subject,
				eventId: 'usage:shared',
				processedTokens: 10,
				createdAt: Date.now()
			});
			await ctx.db.insert('threadUsageEvents', {
				threadId: dropId,
				userId: subject,
				eventId: 'usage:extra',
				processedTokens: 3,
				createdAt: Date.now()
			});
			await absorbDuplicateThread(ctx, keepId, dropId);
			const state = await ctx.db
				.query('threadTranscriptStates')
				.withIndex('by_threadId', (query) => query.eq('threadId', keepId))
				.unique();
			const parts = await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (query) => query.eq('threadId', keepId))
				.collect();
			const usage = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', keepId))
				.unique();
			const events = await ctx.db
				.query('threadUsageEvents')
				.withIndex('by_threadId_eventId', (query) => query.eq('threadId', keepId))
				.collect();
			const dropped = await ctx.db.get('threadRecords', dropId);
			return {
				totalParts: state?.totalParts,
				partCount: parts.length,
				partNumbers: parts.map((part) => part.number).sort((a, b) => a - b),
				totalTokensProcessed: usage?.totalTokensProcessed,
				eventCount: events.length,
				dropped
			};
		});

		expect(ids.dropped).toBeNull();
		expect(ids.partCount).toBe(2);
		expect(ids.partNumbers).toEqual([0, 2]);
		expect(ids.totalParts).toBe(3);
		expect(ids.eventCount).toBe(2);
		expect(ids.totalTokensProcessed).toBe(13);
	});
});
