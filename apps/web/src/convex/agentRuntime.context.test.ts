import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { executionSecretHash } from '@convex/lib/auth';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	type ConvexTestInstance
} from './test.setup';

async function readThreadUsage(t: ConvexTestInstance, threadId: Id<'threadRecords'>) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('threadUsage')
			.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
			.unique()
	);
}

describe('agentRuntime context accounting', () => {
	it('fences compaction and usage writes to the active claim', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'context-run-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'context-run',
			executionSecret,
			'Continue the long task'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});

		await expect(
			asUser.mutation(api.agentRuntime.saveContextCompaction, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				summary: 'The setup is complete; implementation remains.',
				processedTokens: 250_000,
				persistForFutureRuns: false
			})
		).resolves.toBe(true);
		await expect(
			asUser.mutation(api.agentRuntime.recordContextUsage, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				contextTokens: 8_000,
				processedTokens: 9_000
			})
		).resolves.toBe(true);

		expect(await readThreadUsage(t, threadId)).toMatchObject({
			contextTokens: 8_000,
			totalTokensProcessed: 259_000
		});

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { claimExpiresAt: Date.now() - 1 });
		});
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-b',
			executionSecret
		});
		await expect(
			asUser.mutation(api.agentRuntime.recordContextUsage, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				contextTokens: 99_000,
				processedTokens: 99_000
			})
		).resolves.toBe(false);
		await expect(
			asUser.mutation(api.agentRuntime.saveContextCompaction, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				summary: 'Stale summary',
				processedTokens: 1,
				persistForFutureRuns: true
			})
		).resolves.toBe(false);
		expect((await readThreadUsage(t, threadId))?.contextTokens).toBe(8_000);
		expect(
			await t.run(async (ctx) => (await ctx.db.get('threadRecords', threadId))?.contextSummary)
		).toBeFalsy();
	});

	it('does not double-count retried usage for the same model turn', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'idempotent-usage-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'idempotent-usage',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});
		const args = {
			runId,
			claimId: 'claim-a',
			executionSecret,
			contextTokens: 8_000,
			processedTokens: 9_000
		};
		await asUser.mutation(api.agentRuntime.recordContextUsage, args);
		await asUser.mutation(api.agentRuntime.recordContextUsage, args);
		expect(await readThreadUsage(t, threadId)).toMatchObject({
			contextTokens: 8_000,
			totalTokensProcessed: 9_000
		});
	});

	it('backfills a baseline usage event without double-counting live events', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (!usage) throw new Error('missing usage');
			await ctx.db.patch('threadUsage', usage._id, { totalTokensProcessed: 40_000 });
		});
		const { backfillUsageLedgerBaseline } = await import('@convex/lib/threadUsage');
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (!usage) throw new Error('missing usage');
			await backfillUsageLedgerBaseline(ctx, usage);
		});
		expect(await readThreadUsage(t, threadId)).toMatchObject({
			totalTokensProcessed: 40_000,
			usageLedgerMigratedAt: expect.any(Number)
		});
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (!usage) throw new Error('missing usage');
			await backfillUsageLedgerBaseline(ctx, usage);
		});
		const events = await t.run(async (ctx) =>
			ctx.db
				.query('threadUsageEvents')
				.withIndex('by_threadId_eventId', (query) => query.eq('threadId', threadId))
				.collect()
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.processedTokens).toBe(40_000);
	});

	it('rejects invalid token accounting values', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'invalid-context-usage-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'invalid-context-usage',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});

		await expect(
			asUser.mutation(api.agentRuntime.recordContextUsage, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				contextTokens: -1,
				processedTokens: 10
			})
		).rejects.toThrow('Invalid token count.');
		expect((await readThreadUsage(t, threadId))?.totalTokensProcessed ?? 0).toBe(0);
	});

	it('getByThreadId returns the thread with usage counters merged in', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'merged-shape-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'merged-shape',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.recordContextUsage, {
			runId,
			claimId: 'claim-a',
			executionSecret,
			contextTokens: 8_000,
			processedTokens: 9_000
		});

		await expect(asUser.query(api.threads.getByThreadId, { threadId })).resolves.toMatchObject({
			contextTokens: 8_000,
			totalTokensProcessed: 9_000
		});
	});

	it('carries a compacted prefix into later runs without replaying covered history', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const firstSecret = 'context-first-secret';
		const first = await createQueuedRun(
			t,
			asUser,
			threadId,
			'context-first',
			firstSecret,
			'Old prompt that should be covered'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: first.runId,
			claimId: 'claim-1',
			executionSecret: firstSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: first.runId,
			expectedStatus: 'running',
			expectedClaimId: 'claim-1',
			text: 'Old work completed',
			status: 'completed'
		});

		const secondSecret = 'context-second-secret';
		const second = await createQueuedRun(
			t,
			asUser,
			threadId,
			'context-second',
			secondSecret,
			'New prompt'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: second.runId,
			claimId: 'claim-2',
			executionSecret: secondSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('runs', {
				threadId,
				userId: 'user_alice',
				submissionId: 'context-concurrent-later',
				status: 'completed',
				executionSecretHash: await executionSecretHash('context-concurrent-later-secret'),
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				startedAt: Date.now() + 1_000,
				completedAt: Date.now() + 1_001
			});
		});
		await asUser.mutation(api.agentRuntime.saveContextCompaction, {
			runId: second.runId,
			claimId: 'claim-2',
			executionSecret: secondSecret,
			summary: 'The old work is complete.',
			processedTokens: 100,
			persistForFutureRuns: true
		});
		expect(
			await t.run(
				async (ctx) => (await ctx.db.get('threadRecords', threadId))?.contextSummaryThroughRunId
			)
		).toBe(first.runId);
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: second.runId,
			expectedStatus: 'running',
			expectedClaimId: 'claim-2',
			text: 'Second work completed',
			status: 'completed'
		});

		const thirdSecret = 'context-third-secret';
		const third = await createQueuedRun(
			t,
			asUser,
			threadId,
			'context-third',
			thirdSecret,
			'Third prompt'
		);
		const context = await asUser.query(api.agentRuntime.getContext, {
			runId: third.runId,
			executionSecret: thirdSecret
		});
		expect(context.agentHistory).toEqual([]);
		expect(context.contextBudget).toEqual({
			contextWindowTokens: 0,
			autoCompactTokenLimit: 0
		});
	});

	it('coerces retired run models before the worker sees them', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'context-retired-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'context-retired',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-retired',
			executionSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { selectedModel: 'grok-4.5', serviceTier: 'fast' });
		});
		const context = await asUser.query(api.agentRuntime.getContext, {
			runId,
			executionSecret
		});
		expect(context.run.selectedModel).toBe('gpt-5.6-sol');
		expect(context.run.serviceTier).toBe('fast');
	});
});
