import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('agentRuntime.start', () => {
	it('claims a queued run and renews the same claim', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'start-claim-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub-claim', executionSecret);

		const claimed = await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-a',
			runId,
			executionSecret
		});
		expect(claimed.claimed).toBe(true);
		expect(claimed.claimExpiresAt).toBeTypeOf('number');

		const run = await t.run(async (ctx) => ctx.db.get('runs', runId));
		expect(run).toMatchObject({
			status: 'running',
			claimId: 'claim-a',
			claimExpiresAt: claimed.claimExpiresAt
		});

		const renewed = await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-a',
			runId,
			executionSecret
		});
		expect(renewed.claimed).toBe(true);
		expect(renewed.claimExpiresAt).toBeGreaterThanOrEqual(claimed.claimExpiresAt ?? 0);
		expect(
			await t.run(async (ctx) => (await ctx.db.get('runs', runId))?.completionAttemptSeq)
		).toBe(0);
	});

	it('refuses a different claim while the lease is active', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'start-busy-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub-busy', executionSecret);

		await asUser.mutation(api.agentRuntime.start, { claimId: 'claim-a', runId, executionSecret });
		await expect(
			asUser.mutation(api.agentRuntime.start, { claimId: 'claim-b', runId, executionSecret })
		).resolves.toEqual({ claimed: false });
	});

	it('rejects completion writes after a claim expires but lets the owner terminalize the run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'start-expired-writes-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-expired-writes',
			executionSecret
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-expired',
			runId,
			executionSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, { claimExpiresAt: Date.now() - 1 });
		});

		await expect(
			asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
				runId,
				claimId: 'claim-expired',
				attemptSeq: 1,
				executionSecret
			})
		).rejects.toThrow('Run is no longer active.');
		await expect(
			asUser.mutation(api.agentRuntime.finalizeClaimFailure, {
				runId,
				claimId: 'claim-someone-else',
				text: 'stale failure',
				lastError: 'claim expired',
				executionSecret
			})
		).resolves.toBe(false);
		await expect(
			asUser.mutation(api.agentRuntime.finalizeClaimFailure, {
				runId,
				claimId: 'claim-expired',
				text: 'stale failure',
				lastError: 'claim expired',
				executionSecret
			})
		).resolves.toBe(true);
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', runId))?.status)).toBe('failed');
	});

	it('never transfers an expired claim to another executor', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'start-takeover-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub-takeover', executionSecret);

		await asUser.mutation(api.agentRuntime.start, { claimId: 'claim-a', runId, executionSecret });

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, {
				completionAttemptSeq: 4,
				claimExpiresAt: Date.now() - 1
			});
		});

		await expect(
			asUser.mutation(api.agentRuntime.start, {
				claimId: 'claim-b',
				runId,
				executionSecret
			})
		).resolves.toEqual({ claimed: false });
		expect(await t.run(async (ctx) => ctx.db.get('runs', runId))).toMatchObject({
			claimId: 'claim-a',
			completionAttemptSeq: 4
		});
	});

	it('does not revive the same claim after its lease lapses', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'start-reclaim-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'sub-reclaim', executionSecret);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-a',
			runId,
			executionSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, {
				completionAttemptSeq: 2,
				claimExpiresAt: Date.now() - 1
			});
		});

		await expect(
			asUser.mutation(api.agentRuntime.start, {
				claimId: 'claim-a',
				runId,
				executionSecret
			})
		).resolves.toEqual({ claimed: false });

		const run = await t.run(async (ctx) => ctx.db.get('runs', runId));
		expect(run).toMatchObject({
			claimId: 'claim-a',
			completionAttemptSeq: 2
		});
	});
});
