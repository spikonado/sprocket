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

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread).not.toHaveProperty('contextTokens');
		expect(thread).not.toHaveProperty('totalTokensProcessed');
		expect(await readThreadUsage(t, threadId)).toMatchObject({
			contextTokens: 8_000,
			totalTokensProcessed: 259_000
		});

		await t.run(async (ctx) => {
			await ctx.db.patch(runId, { claimExpiresAt: Date.now() - 1 });
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
		expect(await t.run(async (ctx) => (await ctx.db.get(threadId))?.contextSummary)).toBeFalsy();
	});

	it('rejects invalid token accounting values', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'invalid-context-usage-secret';
		const { runId } = await createQueuedRun(
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
		expect(await t.run(async (ctx) => ctx.db.get(threadId))).not.toHaveProperty('contextTokens');
	});

	it('migrates legacy on-thread counters on access', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'legacy-usage-secret';
		const { runId } = await createQueuedRun(
			asUser,
			threadId,
			'legacy-usage',
			executionSecret,
			'Continue'
		);
		// Simulate a pre-migration row: legacy counters on the thread, no usage row.
		await t.run(async (ctx) => {
			const usageRow = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (usageRow) await ctx.db.delete(usageRow._id);
			await ctx.db.patch(threadId, { contextTokens: 4_000, totalTokensProcessed: 100_000 });
		});

		// The merged read keeps the old response shape before migration.
		await expect(asUser.query(api.threads.getByThreadId, { threadId })).resolves.toMatchObject({
			contextTokens: 4_000,
			totalTokensProcessed: 100_000
		});
		// Opening the thread (clients fire setLastThread) schedules the migration.
		await asUser.mutation(api.uiPreferences.setLastThread, { threadId });
		// convex-test fires scheduled functions on a macrotask before tracking them.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await t.finishInProgressScheduledFunctions();
		const migratedThread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(migratedThread).not.toHaveProperty('contextTokens');
		expect(migratedThread).not.toHaveProperty('totalTokensProcessed');
		expect(await readThreadUsage(t, threadId)).toMatchObject({
			contextTokens: 4_000,
			totalTokensProcessed: 100_000
		});

		// Writes after migration accumulate onto the migrated totals.
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.recordContextUsage, {
			runId,
			claimId: 'claim-a',
			executionSecret,
			contextTokens: 5_000,
			processedTokens: 6_000
		});
		expect(await readThreadUsage(t, threadId)).toMatchObject({
			contextTokens: 5_000,
			totalTokensProcessed: 106_000
		});
	});

	it('folds legacy counters into the first usage write', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'legacy-fold-secret';
		const { runId } = await createQueuedRun(
			asUser,
			threadId,
			'legacy-fold',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});
		await t.run(async (ctx) => {
			const usageRow = await ctx.db
				.query('threadUsage')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (usageRow) await ctx.db.delete(usageRow._id);
			await ctx.db.patch(threadId, { contextTokens: 4_000, totalTokensProcessed: 100_000 });
		});

		await asUser.mutation(api.agentRuntime.recordContextUsage, {
			runId,
			claimId: 'claim-a',
			executionSecret,
			contextTokens: 7_000,
			processedTokens: 10_000
		});

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread).not.toHaveProperty('contextTokens');
		expect(thread).not.toHaveProperty('totalTokensProcessed');
		expect(await readThreadUsage(t, threadId)).toMatchObject({
			contextTokens: 7_000,
			totalTokensProcessed: 110_000
		});
	});

	it('carries a compacted prefix into later runs without replaying covered history', async () => {
		const t = initConvexTest();
		const { asUser, threadId, projectId } = await seedOwnedThread(t);
		const firstSecret = 'context-first-secret';
		const first = await createQueuedRun(
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
				projectId,
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
			await t.run(async (ctx) => (await ctx.db.get(threadId))?.contextSummaryThroughRunId)
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
		const serialized = JSON.stringify(context.agentHistory);
		expect(serialized).toContain('The old work is complete.');
		expect(serialized).not.toContain('Old prompt that should be covered');
		expect(serialized).toContain('New prompt');
		expect(context.contextBudget).toEqual({
			contextWindowTokens: 258_400,
			autoCompactTokenLimit: 244_800
		});
	});
});
