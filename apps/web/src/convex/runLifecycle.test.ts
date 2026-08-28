import { describe, expect, it } from 'vitest';
import type { WorkflowId } from '@convex-dev/workflow';
import { api, internal } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';
import { RUN_QUEUED_STARTUP_DEADLINE_MS } from '@convex/lib/runLease';

describe('run lifecycle workflow', () => {
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
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: created.runId,
			expectedStatus: 'awaiting_executor',
			expectedClaimId: 'claim-r',
			text: 'done',
			status: 'completed'
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
		const run = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		const workflowId = run?.lifecycleWorkflowId;
		expect(workflowId).toEqual(expect.any(String));
		await t.mutation(internal.runLifecycle.finishLifecycle, {
			runId: created.runId,
			// SAFETY: stored by startRunLifecycle; convex-test uses the dummy id.
			workflowId: workflowId as WorkflowId
		});
		const finished = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(finished?.lifecycleWorkflowId).toBeUndefined();
	});
});
