import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowId } from '@convex-dev/workflow';
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
		const run = await t.run((ctx) => ctx.db.get('runs', runId));
		expect(run).not.toHaveProperty('lifecycleWorkflowId');
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

describe('legacy run lifecycle compatibility', () => {
	it('materializes an abandoned queued run after the startup deadline', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'abandoned-queued',
			'abandoned-secret',
			'Hello'
		);
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, {
				startedAt: Date.now() - RUN_QUEUED_STARTUP_DEADLINE_MS - 1
			});
		});
		expect(
			await t.mutation(internal.runLifecycle.abandonExpiredRun, { runId: created.runId })
		).toBe(true);
		const run = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(run).toMatchObject({
			status: 'failed',
			lastError: 'The local agent stopped responding before this run finished.'
		});
	});

	it('waits while a claimed lease is still active', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'claimed-wait',
			'claimed-secret',
			'Hello'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId: 'claim-live',
			executionSecret: 'claimed-secret'
		});
		await t.run((ctx) =>
			ctx.db.patch('runs', created.runId, { lifecycleWorkflowId: 'legacy-workflow' })
		);
		expect(
			await t.mutation(internal.runLifecycle.abandonExpiredRun, { runId: created.runId })
		).toBe(false);
		const state = await t.query(internal.runLifecycle.getWatchState, { runId: created.runId });
		expect(state.kind).toBe('wait');
	});

	it('reconciles cancelled jobs in bounded pages after a terminal run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'reconcile-secret';
		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'reconcile-run',
			executionSecret,
			'Hello'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId: 'claim-r',
			executionSecret
		});
		const job = await asUser.mutation(api.agentRuntime.beginToolJob, {
			runId: created.runId,
			claimId: 'claim-r',
			kind: 'exec_command',
			payload: { cmd: 'true' },
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: created.runId,
			expectedStatus: 'running',
			expectedClaimId: 'claim-r',
			text: 'done',
			status: 'completed',
			executionSecret
		});
		const stored = await t.run(async (ctx) => ctx.db.get('executorJobs', job.jobId));
		expect(stored?.status).toBe('cancelled');
		const page = await t.mutation(internal.runLifecycle.reconcileTerminalPage, {
			runId: created.runId,
			jobCursor: -1,
			questionCursor: -1,
			transcriptCursor: -1
		});
		expect(page.done).toBe(true);
	});

	it('clears the stored lifecycle workflow id', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'finish-lifecycle',
			'finish-secret',
			'Hello'
		);
		await t.run((ctx) =>
			ctx.db.patch('runs', created.runId, { lifecycleWorkflowId: 'legacy-workflow' })
		);
		await t.mutation(internal.runLifecycle.finishLifecycle, {
			runId: created.runId,
			// SAFETY: matches the legacy workflow ID stored by this fixture.
			workflowId: 'legacy-workflow' as WorkflowId
		});
		const finished = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(finished?.lifecycleWorkflowId).toBeUndefined();
	});
});
