import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('agentRuntime completion stream state', () => {
	it('tracks completion attempts without writing live tokens on Convex', async () => {
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
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-stream',
			attemptSeq: 1,
			executionSecret
		});

		const stored = await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', runId);
			if (!run?.completionStreamStateId) {
				throw new Error('Expected stream state record');
			}
			return {
				state: await ctx.db.get('completionStreamStates', run.completionStreamStateId)
			};
		});
		expect(
			(await t.run(async (ctx) => (await ctx.db.get('runs', runId))?.responseMessageId)) ??
				undefined
		).toBeUndefined();
		expect(
			await t.run(async (ctx) => (await ctx.db.get('runs', runId))?.completionAttemptSeq)
		).toBe(1);
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
