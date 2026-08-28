import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('agentRuntime completion stream state', () => {
	it('creates a response message without writing live tokens on Convex', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'stream-state-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-stream-state',
			executionSecret,
			'Stream a response'
		);

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

		const stored = await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', runId);
			if (!run?.responseMessageId || !run.completionStreamStateId) {
				throw new Error('Expected response and stream state records');
			}
			return {
				message: await ctx.db.get('threadMessages', run.responseMessageId),
				state: await ctx.db.get('completionStreamStates', run.completionStreamStateId)
			};
		});
		expect(stored.message).toMatchObject({ text: '' });
		expect(stored.state).toMatchObject({
			runId,
			sequence: 0
		});
		expect(
			await asUser.query(api.agentRuntime.completionActor, { runId, executionSecret })
		).toMatchObject({
			streamSequence: 0
		});
	});
});
