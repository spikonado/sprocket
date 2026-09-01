import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { CANCELLATION_FORCE_AFTER_MS } from '@convex/lib/runCancellation';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

describe('chat.selectedThreadLifecycle', { timeout: 20_000 }, () => {
	it('is idle when the thread has no run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		expect(await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).toEqual({
			threadId,
			phase: 'idle',
			run: null
		});
	});
});

describe('durable run cancellation', { timeout: 30_000 }, () => {
	it('writes the request, blocks new work, and force-cancels after the deadline', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'cancel-secret';
		const created = await createQueuedRun(t, asUser, threadId, 'cancel-run', executionSecret);
		await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', created.runId);
			if (!run) {
				throw new Error('queued run missing');
			}
			await ctx.db.insert('installations', {
				userId: run.userId,
				installationId: 'install-lifecycle',
				friendlyName: 'Workshop',
				platform: 'linux',
				architecture: 'x86_64',
				appVersion: '0.3.2',
				createdAt: Date.now(),
				updatedAt: Date.now()
			});
			await ctx.db.patch('runs', created.runId, { installationId: 'install-lifecycle' });
		});
		const queued = await asUser.query(api.chat.selectedThreadLifecycle, { threadId });
		expect(queued).toEqual({
			threadId,
			phase: 'queued',
			run: {
				runId: created.runId,
				startedAt: queued.run?.startedAt,
				executorFriendlyName: 'Workshop'
			}
		});
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-cancel',
			runId: created.runId,
			executionSecret
		});
		expect(await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).toMatchObject({
			phase: 'running',
			run: { runId: created.runId }
		});

		expect(await asUser.mutation(api.agentRuntime.requestCancellation, { runId: created.runId })).toBe(
			true
		);
		expect(await asUser.mutation(api.agentRuntime.requestCancellation, { runId: created.runId })).toBe(
			true
		);
		const requested = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(requested?.cancellationRequestedAt).toEqual(expect.any(Number));
		expect(requested?.cancellationDeadlineAt).toBe(
			(requested?.cancellationRequestedAt ?? 0) + CANCELLATION_FORCE_AFTER_MS
		);
		expect(requested?.status).toBe('running');
		expect(await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).toMatchObject({
			phase: 'cancellation_requested'
		});
		expect(
			await asUser.query(api.agentRuntime.isFinished, {
				runId: created.runId,
				executionSecret
			})
		).toBe(true);

		await expect(
			asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
				runId: created.runId,
				claimId: 'claim-cancel',
				attemptSeq: 1,
				executionSecret
			})
		).rejects.toThrow('Run is cancelled.');
		await expect(
			asUser.mutation(api.agentRuntime.beginToolJob, {
				claimId: 'claim-cancel',
				runId: created.runId,
				kind: 'exec_command',
				payload: { cmd: 'true' },
				executionSecret
			})
		).rejects.toThrow('Run is cancelled.');

		expect(
			await t.mutation(internal.runLifecycle.forceCancelRun, { runId: created.runId })
		).toBe(false);
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { cancellationDeadlineAt: Date.now() - 1 });
		});
		expect(
			await t.mutation(internal.runLifecycle.forceCancelRun, { runId: created.runId })
		).toBe(true);
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', created.runId))?.status)).toBe(
			'cancelled'
		);
	});

	it('lets completed win before the deadline and maps executor failure to cancelled', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'complete-wins-secret';
		const completed = await createQueuedRun(t, asUser, threadId, 'complete-wins', executionSecret);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-complete',
			runId: completed.runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId: completed.runId });
		expect(
			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId: completed.runId,
				expectedClaimId: 'claim-complete',
				text: 'done',
				status: 'completed',
				executionSecret
			})
		).toBe(true);
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', completed.runId))?.status)).toBe(
			'completed'
		);
		expect(
			await t.mutation(internal.runLifecycle.forceCancelRun, { runId: completed.runId })
		).toBe(false);

		const failed = await createQueuedRun(t, asUser, threadId, 'fail-to-cancel', 'fail-secret');
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-fail',
			runId: failed.runId,
			executionSecret: 'fail-secret'
		});
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId: failed.runId });
		expect(
			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId: failed.runId,
				expectedClaimId: 'claim-fail',
				text: 'boom',
				status: 'failed',
				lastError: 'model exploded',
				executionSecret: 'fail-secret'
			})
		).toBe(true);
		expect(await t.run(async (ctx) => ctx.db.get('runs', failed.runId))).toMatchObject({
			status: 'cancelled',
			lastError: 'model exploded'
		});
	});

	it('keeps immediate finalizeRun cancellation as a compatibility shim', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'shim-cancel-secret';
		const created = await createQueuedRun(t, asUser, threadId, 'shim-cancel', executionSecret);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-shim',
			runId: created.runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: created.runId,
			text: '',
			status: 'cancelled'
		});
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', created.runId))?.status)).toBe(
			'cancelled'
		);
	});
});
