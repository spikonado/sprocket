import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('agentRuntime completion stream state', () => {
	it('tracks the stream cursor outside the growing response message', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'stream-state-secret';
		const { runId } = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'sub-stream-state',
			threadId,
			prompt: 'Stream a response',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			executionSecret
		});

		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-stream',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.beginAssistantMessage, { runId, executionSecret });
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-stream',
			attemptSeq: 1,
			executionSecret
		});
		await expect(
			asUser.mutation(api.agentRuntime.mergeAssistantStreamEvents, {
				runId,
				claimId: 'claim-stream',
				attemptSeq: 1,
				streamId: 'stream-1',
				sequence: 1,
				events: [{ type: 'text', id: 'text-1', text: 'Hello' }],
				executionSecret
			})
		).resolves.toBe('merged');

		const stored = await t.run(async (ctx) => {
			const run = await ctx.db.get(runId);
			if (!run?.responseMessageId || !run.completionStreamStateId) {
				throw new Error('Expected response and stream state records');
			}
			return {
				message: await ctx.db.get(run.responseMessageId),
				state: await ctx.db.get(run.completionStreamStateId)
			};
		});
		expect(stored.message).toMatchObject({ text: 'Hello' });
		expect(stored.state).toMatchObject({
			runId,
			sequence: 1,
			streamAttemptId: 'stream-1'
		});
		expect(
			await asUser.query(api.agentRuntime.completionActor, { runId, executionSecret })
		).toMatchObject({
			streamSequence: 1,
			streamAttemptId: 'stream-1'
		});
	});
});
