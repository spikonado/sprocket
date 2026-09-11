import { describe, expect, it } from 'vitest';
import { getRunWithExecution } from '@convex/lib/runExecution';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('agentRuntime completion actor', () => {
	it('authenticates the actor and tracks attempts without stream storage', async () => {
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

		const stored = await t.run(async (ctx) => ({
			run: await ctx.db.get('runs', runId),
			state: await ctx.db.query('completionStreamStates').first()
		}));
		expect(
			await t.run(async (ctx) => (await getRunWithExecution(ctx.db, runId))?.completionAttemptSeq)
		).toBe(1);
		expect(stored.run).not.toHaveProperty('completionStreamStateId');
		expect(stored.state).toBeNull();
		expect(
			await asUser.query(api.agentRuntime.completionActor, { runId, executionSecret })
		).toEqual({
			userId: stored.run?.userId,
			threadId,
			status: 'running',
			claimId: 'claim-stream',
			claimExpiresAt: expect.any(Number)
		});
		await expect(
			asUser.query(api.agentRuntime.completionActor, {
				runId,
				executionSecret: 'wrong-secret'
			})
		).rejects.toThrow('Run not found.');
	});

	it('ignores a dangling legacy stream pointer', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'dangling-stream-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'dangling-stream',
			executionSecret
		);
		await t.run(async (ctx) => {
			const stateId = await ctx.db.insert('completionStreamStates', {
				runId,
				userId: 'user_alice',
				sequence: 9,
				streamAttemptId: 'retired'
			});
			await ctx.db.patch('runs', runId, { completionStreamStateId: stateId });
			await ctx.db.delete('completionStreamStates', stateId);
		});
		await expect(
			asUser.query(api.agentRuntime.completionActor, {
				runId,
				executionSecret
			})
		).resolves.toEqual({ userId: 'user_alice', threadId, status: 'queued' });
		const context = await asUser.query(api.agentRuntime.getContext, { runId, executionSecret });
		expect(context.run).not.toHaveProperty('completionStreamStateId');
	});
});
