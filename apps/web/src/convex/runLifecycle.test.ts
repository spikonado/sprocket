import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';
import { RUN_CLAIM_LEASE_DURATION_MS, RUN_QUEUED_STARTUP_DEADLINE_MS } from '@convex/lib/runLease';
import { getRunExecutionState, patchRunExecution } from '@convex/lib/runExecution';
import { startRunLifecycle } from './runLifecycle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('native run lifecycle', () => {
	it('schedules one startup check and expires an abandoned run without creating a workflow', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'native-queued', 'native-secret');
		const state = await t.run((ctx) => getRunExecutionState(ctx.db, runId));
		if (!state?.lifecycleCheckId) throw new Error('Missing lifecycle check.');
		const scheduledId = state.lifecycleCheckId;
		expect(
			await t.run((ctx) => ctx.db.system.get('_scheduled_functions', scheduledId))
		).toMatchObject({
			scheduledTime: Date.now() + RUN_QUEUED_STARTUP_DEADLINE_MS,
			state: { kind: 'pending' }
		});
		await t.run((ctx) => startRunLifecycle(ctx, runId));
		expect(await t.run((ctx) => getRunExecutionState(ctx.db, runId))).toEqual(state);
		await vi.advanceTimersByTimeAsync(RUN_QUEUED_STARTUP_DEADLINE_MS - 1);
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toMatchObject({ status: 'queued' });
		await vi.advanceTimersByTimeAsync(1);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toMatchObject({
			status: 'failed',
			lastError: 'The local agent stopped responding before this run finished.'
		});
		expect(await t.run((ctx) => getRunExecutionState(ctx.db, runId))).not.toHaveProperty(
			'lifecycleCheckId'
		);
	});

	it('checks the current lease only at its deadline and ignores stale generations', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'native-renew-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'native-renew', executionSecret);
		await asUser.mutation(api.agentRuntime.start, { runId, executionSecret, claimId: 'live' });
		await vi.advanceTimersByTimeAsync(RUN_QUEUED_STARTUP_DEADLINE_MS);
		await t.finishInProgressScheduledFunctions();
		const state = await t.run((ctx) => getRunExecutionState(ctx.db, runId));
		if (!state?.lifecycleCheckId || !state.claimExpiresAt) throw new Error('Missing lease check.');
		const scheduledId = state.lifecycleCheckId;
		expect(
			await t.run((ctx) => ctx.db.system.get('_scheduled_functions', scheduledId))
		).toMatchObject({
			scheduledTime: state.claimExpiresAt
		});
		await t.mutation(internal.runLifecycle.checkRun, { runId, generation: 1 });
		expect(await t.run((ctx) => getRunExecutionState(ctx.db, runId))).toEqual(state);
		const renewedDeadline = state.claimExpiresAt + RUN_CLAIM_LEASE_DURATION_MS;
		await t.run((ctx) => patchRunExecution(ctx, runId, { claimExpiresAt: renewedDeadline }));
		await vi.advanceTimersByTimeAsync(state.claimExpiresAt - Date.now());
		await t.finishInProgressScheduledFunctions();
		const renewed = await t.run((ctx) => getRunExecutionState(ctx.db, runId));
		if (!renewed?.lifecycleCheckId) throw new Error('Missing renewed check.');
		const renewedId = renewed.lifecycleCheckId;
		expect(
			await t.run((ctx) => ctx.db.system.get('_scheduled_functions', renewedId))
		).toMatchObject({
			scheduledTime: renewedDeadline
		});
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toMatchObject({ status: 'running' });
		await vi.advanceTimersByTimeAsync(renewedDeadline - Date.now());
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toMatchObject({ status: 'failed' });
	});

	it('cancels the pending deadline check when a run completes', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'native-complete-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'native-complete',
			executionSecret
		);
		await asUser.mutation(api.agentRuntime.start, { runId, executionSecret, claimId: 'live' });
		const state = await t.run((ctx) => getRunExecutionState(ctx.db, runId));
		if (!state?.lifecycleCheckId) throw new Error('Missing lifecycle check.');
		const scheduledId = state.lifecycleCheckId;
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret,
			expectedStatus: 'running',
			expectedClaimId: 'live',
			text: 'done',
			status: 'completed'
		});
		expect(
			await t.run((ctx) => ctx.db.system.get('_scheduled_functions', scheduledId))
		).toMatchObject({
			state: { kind: 'canceled' }
		});
		await t.mutation(internal.runLifecycle.checkRun, {
			runId,
			generation: state.lifecycleGeneration ?? 0
		});
		expect(await t.run((ctx) => getRunExecutionState(ctx.db, runId))).not.toHaveProperty(
			'lifecycleCheckId'
		);
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toMatchObject({ status: 'completed' });
	});

	it('replaces a canceled scheduler entry without accepting its old generation', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'native-repair', 'repair-secret');
		const state = await t.run((ctx) => getRunExecutionState(ctx.db, runId));
		if (!state?.lifecycleCheckId) throw new Error('Missing lifecycle check.');
		const scheduledId = state.lifecycleCheckId;
		await t.run((ctx) => ctx.scheduler.cancel(scheduledId));
		await t.run((ctx) => startRunLifecycle(ctx, runId));
		const replacement = await t.run((ctx) => getRunExecutionState(ctx.db, runId));
		expect(replacement?.lifecycleCheckId).not.toBe(scheduledId);
		expect(replacement?.lifecycleGeneration).toBe(2);
		await t.mutation(internal.runLifecycle.checkRun, { runId, generation: 1 });
		expect(await t.run((ctx) => getRunExecutionState(ctx.db, runId))).toEqual(replacement);
	});
});
