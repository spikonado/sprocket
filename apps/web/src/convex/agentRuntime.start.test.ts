import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { RUN_CLAIM_LEASE_DURATION_MS } from '@convex/lib/runLease';
import { initConvexTest, seedOwnedThread } from './test.setup';

async function createQueuedRun(
	asUser: ReturnType<ReturnType<typeof initConvexTest>['withIdentity']>,
	threadId: Id<'threadRecords'>,
	submissionId: string
) {
	return await asUser.mutation(api.agentRuntime.createRun, {
		submissionId,
		threadId,
		prompt: 'Do the thing',
		imageUploadIds: [],
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard'
	});
}

describe('agentRuntime.start', () => {
	it('claims a queued run and renews the same claim', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(asUser, threadId, 'sub-claim');

		const claimed = await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-a',
			runId
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
			runId
		});
		expect(renewed.claimed).toBe(true);
		expect(renewed.claimExpiresAt).toBeGreaterThanOrEqual(claimed.claimExpiresAt ?? 0);
		expect(await t.run(async (ctx) => (await ctx.db.get(runId))?.completionAttemptSeq)).toBe(0);
	});

	it('refuses a different claim while the lease is active', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(asUser, threadId, 'sub-busy');

		await asUser.mutation(api.agentRuntime.start, { claimId: 'claim-a', runId });
		await expect(
			asUser.mutation(api.agentRuntime.start, { claimId: 'claim-b', runId })
		).resolves.toEqual({ claimed: false });
	});

	it('takes over an expired claim, hides in-flight jobs, and clears partial response', async () => {
		const t = initConvexTest();
		const { asUser, threadId, workspaceSessionId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(asUser, threadId, 'sub-takeover');

		await asUser.mutation(api.agentRuntime.start, { claimId: 'claim-a', runId });

		const { responseMessageId, pendingJobId, completedJobId } = await t.run(async (ctx) => {
			const responseMessageId = await ctx.db.insert('threadMessages', {
				threadId,
				runId,
				userId: 'user_alice',
				type: 'response',
				text: 'partial',
				parts: [{ type: 'text', id: 'text-1', text: 'partial', turnId: 'turn-1' }],
				streamSequence: 3,
				streamAttemptId: 'attempt-a'
			});
			const pendingJobId = await ctx.db.insert('executorJobs', {
				workspaceSessionId,
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
				workspaceSessionId,
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
			return { responseMessageId, pendingJobId, completedJobId };
		});

		const takeover = await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-b',
			runId
		});
		expect(takeover.claimed).toBe(true);
		expect(takeover.claimExpiresAt).toBeGreaterThan(Date.now());

		const state = await t.run(async (ctx) => {
			const run = await ctx.db.get(runId);
			const response = await ctx.db.get(responseMessageId);
			const pending = await ctx.db.get(pendingJobId);
			const completed = await ctx.db.get(completedJobId);
			return { run, response, pending, completed };
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
			parts: [],
			streamSequence: 0
		});
		expect(state.response?.streamAttemptId ?? undefined).toBeUndefined();
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
