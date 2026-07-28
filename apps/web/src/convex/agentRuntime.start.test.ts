import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { RUN_CLAIM_LEASE_DURATION_MS } from '@convex/lib/runLease';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('agentRuntime.start', () => {
	it('claims a queued run and renews the same claim', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'start-claim-secret';
		const { runId } = await createQueuedRun(asUser, threadId, 'sub-claim', executionSecret);

		const claimed = await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-a',
			runId,
			executionSecret
		});
		expect(claimed.claimed).toBe(true);
		expect(claimed.claimExpiresAt).toBeTypeOf('number');

		const run = await t.run(async (ctx) => ctx.db.get(runId));
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
		expect(await t.run(async (ctx) => (await ctx.db.get(runId))?.completionAttemptSeq)).toBe(0);
	});

	it('refuses a different claim while the lease is active', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'start-busy-secret';
		const { runId } = await createQueuedRun(asUser, threadId, 'sub-busy', executionSecret);

		await asUser.mutation(api.agentRuntime.start, { claimId: 'claim-a', runId, executionSecret });
		await expect(
			asUser.mutation(api.agentRuntime.start, { claimId: 'claim-b', runId, executionSecret })
		).resolves.toEqual({ claimed: false });
	});

	it('rejects completion writes and terminal cleanup after a claim expires', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'start-expired-writes-secret';
		const { runId } = await createQueuedRun(
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
			await ctx.db.patch(runId, { claimExpiresAt: Date.now() - 1 });
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
				claimId: 'claim-expired',
				text: 'stale failure',
				lastError: 'claim expired',
				executionSecret
			})
		).resolves.toBe(false);
	});

	it('takes over an expired claim, hides in-flight jobs, and clears partial response', async () => {
		const t = initConvexTest();
		const { asUser, threadId, projectId } = await seedOwnedThread(t);
		const executionSecret = 'start-takeover-secret';
		const { runId } = await createQueuedRun(asUser, threadId, 'sub-takeover', executionSecret);

		await asUser.mutation(api.agentRuntime.start, { claimId: 'claim-a', runId, executionSecret });

		const seeded = await t.run(async (ctx) => {
			const run = await ctx.db.get(runId);
			if (!run?.completionStreamStateId) {
				throw new Error('Expected completion stream state');
			}
			await ctx.db.patch(run.completionStreamStateId, {
				sequence: 3,
				streamAttemptId: 'attempt-a'
			});
			const responseMessageId = await ctx.db.insert('threadMessages', {
				threadId,
				runId,
				userId: 'user_alice',
				type: 'response',
				text: 'partial',
				parts: [{ type: 'text', id: 'text-1', text: 'partial', turnId: 'turn-1' }]
			});
			const pendingJobId = await ctx.db.insert('executorJobs', {
				projectId,
				threadId,
				runId,
				kind: 'exec_command',
				payload: { cmd: 'sleep 1' },
				hidden: false,
				status: 'pending',
				enqueuedAt: Date.now(),
				sequence: 0
			});
			const completedJobId = await ctx.db.insert('executorJobs', {
				projectId,
				threadId,
				runId,
				kind: 'exec_command',
				payload: { cmd: 'echo ok' },
				hidden: false,
				status: 'completed',
				enqueuedAt: Date.now(),
				completedAt: Date.now(),
				result: {
					command: 'echo ok',
					cwd: '/',
					exitCode: 0,
					success: true,
					running: false,
					timedOut: false,
					stdout: 'ok',
					stderr: '',
					output: 'ok',
					truncated: false
				},
				sequence: 1
			});
			await ctx.db.patch(runId, {
				responseMessageId,
				activeJobId: pendingJobId,
				completionAttemptSeq: 4,
				claimExpiresAt: Date.now() - 1
			});
			return {
				responseMessageId,
				streamStateId: run.completionStreamStateId,
				pendingJobId,
				completedJobId
			};
		});

		const takeover = await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-b',
			runId,
			executionSecret
		});
		expect(takeover.claimed).toBe(true);
		expect(takeover.claimExpiresAt).toBeGreaterThan(Date.now());

		const state = await t.run(async (ctx) => {
			const run = await ctx.db.get(runId);
			const response = await ctx.db.get(seeded.responseMessageId);
			const stream = await ctx.db.get(seeded.streamStateId);
			const pending = await ctx.db.get(seeded.pendingJobId);
			const completed = await ctx.db.get(seeded.completedJobId);
			return { run, response, stream, pending, completed };
		});

		expect(state.run).toMatchObject({
			claimId: 'claim-b',
			status: 'running',
			completionAttemptSeq: 0
		});
		expect(state.run?.activeJobId ?? undefined).toBeUndefined();
		expect(state.run?.claimExpiresAt).toBe(takeover.claimExpiresAt);
		expect(state.response).toMatchObject({
			text: '',
			parts: []
		});
		expect(state.stream).toMatchObject({
			sequence: 0
		});
		expect(state.stream?.streamAttemptId ?? undefined).toBeUndefined();
		expect(state.pending).toMatchObject({
			hidden: true,
			status: 'cancelled',
			error: 'The agent worker claim expired.'
		});
		expect(state.completed).toMatchObject({
			hidden: false,
			status: 'completed'
		});
		expect(takeover.claimExpiresAt).toBeLessThanOrEqual(
			Date.now() + RUN_CLAIM_LEASE_DURATION_MS + 1_000
		);
	});
});
