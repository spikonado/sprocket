import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('executor finalization acknowledgments', () => {
	it('returns the committed cancellation rather than a requested failure or stale completion', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'output-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'output-cancel', executionSecret);
		await asUser.mutation(api.agentRuntime.start, { runId, executionSecret, claimId: 'claim' });
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId });
		const result = await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret,
			expectedClaimId: 'claim',
			status: 'failed',
			text: '',
			includeOutput: true
		});
		expect(result).toEqual({ accepted: true, outcome: { status: 'cancelled', error: null } });
		expect(
			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId,
				executionSecret,
				expectedClaimId: 'claim',
				status: 'completed',
				text: 'done',
				includeOutput: true
			})
		).toEqual({ accepted: false, outcome: { status: 'cancelled', error: null } });
	});

	it('preserves boolean responses for installed clients and does not invent a terminal result after losing ownership', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'output-compat-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'output-compat', executionSecret);
		await asUser.mutation(api.agentRuntime.start, { runId, executionSecret, claimId: 'owner' });
		expect(
			await asUser.mutation(api.agentRuntime.finalizeClaimFailure, {
				runId,
				executionSecret,
				claimId: 'other',
				text: '',
				lastError: 'lost',
				includeOutput: true
			})
		).toEqual({ accepted: false, outcome: null });
		expect(
			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId,
				executionSecret,
				expectedClaimId: 'owner',
				status: 'completed',
				text: 'done'
			})
		).toBe(true);
	});

	it('returns a committed failure and keeps execution capability checks', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'output-failure-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'output-failure', executionSecret);
		await asUser.mutation(api.agentRuntime.start, { runId, executionSecret, claimId: 'owner' });
		await expect(
			asUser.mutation(api.agentRuntime.finalizeClaimFailure, {
				runId,
				executionSecret: 'wrong',
				claimId: 'owner',
				text: '',
				lastError: 'lost',
				includeOutput: true
			})
		).rejects.toThrow();
		expect(
			await asUser.mutation(api.agentRuntime.finalizeClaimFailure, {
				runId,
				executionSecret,
				claimId: 'owner',
				text: '',
				lastError: 'lost',
				includeOutput: true
			})
		).toEqual({ accepted: true, outcome: { status: 'failed', error: 'lost' } });
	});
});
