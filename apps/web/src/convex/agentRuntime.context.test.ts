import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('agentRuntime context accounting', () => {
	it('fences compaction and usage writes to the current completion attempt', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'context-run',
			threadId,
			prompt: 'Continue the long task',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		await asUser.mutation(api.agentRuntime.start, { runId, claimId: 'claim-a' });
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-a',
			attemptSeq: 1
		});

		await expect(
			asUser.mutation(api.agentRuntime.saveContextCompaction, {
				runId,
				claimId: 'claim-a',
				attemptSeq: 1,
				summary: 'The setup is complete; implementation remains.',
				messageCount: 12,
				processedTokens: 250_000,
				persistForFutureRuns: false
			})
		).resolves.toBe(true);
		await expect(
			asUser.mutation(api.agentRuntime.recordContextUsage, {
				runId,
				claimId: 'claim-a',
				attemptSeq: 1,
				contextTokens: 8_000,
				processedTokens: 9_000
			})
		).resolves.toBe(true);

		const thread = await t.run(async (ctx) => ctx.db.get(threadId));
		expect(thread).toMatchObject({
			contextTokens: 8_000,
			totalTokensProcessed: 259_000
		});

		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-a',
			attemptSeq: 2
		});
		await expect(
			asUser.mutation(api.agentRuntime.recordContextUsage, {
				runId,
				claimId: 'claim-a',
				attemptSeq: 1,
				contextTokens: 99_000,
				processedTokens: 99_000
			})
		).resolves.toBe(false);
		expect(await t.run(async (ctx) => (await ctx.db.get(threadId))?.contextTokens)).toBe(8_000);
	});

	it('rejects invalid token accounting values', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'invalid-context-usage',
			threadId,
			prompt: 'Continue',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		await asUser.mutation(api.agentRuntime.start, { runId, claimId: 'claim-a' });
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-a',
			attemptSeq: 1
		});

		await expect(
			asUser.mutation(api.agentRuntime.recordContextUsage, {
				runId,
				claimId: 'claim-a',
				attemptSeq: 1,
				contextTokens: -1,
				processedTokens: 10
			})
		).rejects.toThrow('Invalid token count.');
		expect(await t.run(async (ctx) => ctx.db.get(threadId))).not.toHaveProperty('contextTokens');
	});

	it('carries a compacted prefix into later runs without replaying covered history', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const first = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'context-first',
			threadId,
			prompt: 'Old prompt that should be covered',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		await asUser.mutation(api.agentRuntime.start, { runId: first.runId, claimId: 'claim-1' });
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: first.runId,
			expectedStatus: 'running',
			expectedClaimId: 'claim-1',
			text: 'Old work completed',
			status: 'completed'
		});

		const second = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'context-second',
			threadId,
			prompt: 'New prompt',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		await asUser.mutation(api.agentRuntime.start, { runId: second.runId, claimId: 'claim-2' });
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId: second.runId,
			claimId: 'claim-2',
			attemptSeq: 1
		});
		await asUser.mutation(api.agentRuntime.saveContextCompaction, {
			runId: second.runId,
			claimId: 'claim-2',
			attemptSeq: 1,
			summary: 'The old work is complete.',
			messageCount: 2,
			processedTokens: 100,
			persistForFutureRuns: true
		});
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: second.runId,
			expectedStatus: 'running',
			expectedClaimId: 'claim-2',
			text: 'Second work completed',
			status: 'completed'
		});

		const third = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'context-third',
			threadId,
			prompt: 'Third prompt',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		const context = await asUser.query(api.agentRuntime.getContext, { runId: third.runId });
		const serialized = JSON.stringify(context.agentHistory);
		expect(serialized).toContain('The old work is complete.');
		expect(serialized).not.toContain('Old prompt that should be covered');
		expect(serialized).toContain('New prompt');
	});
});
