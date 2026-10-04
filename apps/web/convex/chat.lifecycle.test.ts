import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { CANCELLATION_FORCE_AFTER_MS } from '@convex/lib/runCancellation';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	toolTranscriptAssignment
} from './test.setup';
import { registerChildThread } from '@convex/lib/threadHierarchy';

async function runWithQuestion(
	t: ReturnType<typeof initConvexTest>,
	parentThreadId?: Id<'threadRecords'>
) {
	const { asUser, threadId } = await seedOwnedThread(t);

	if (parentThreadId) {
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { parentThreadId });
			await registerChildThread(ctx, (await ctx.db.get('threadRecords', threadId))!);
		});
	}

	const executionSecret = 'question-cancellation-secret';

	const { runId } = await createQueuedRun(
		t,
		asUser,
		threadId,
		`question-run-${threadId}`,
		executionSecret
	);

	const claimId = 'question-claim';
	await asUser.mutation(api.agentRuntime.start, { runId, claimId, executionSecret });
	await asUser.mutation(api.agentRuntime.beginToolJob, {
		runId,
		claimId,
		executionSecret,
		...toolTranscriptAssignment(runId, claimId),
		kind: 'ask_question',
		payload: { question: 'Which target?', options: [{ id: 'a', label: 'Target A' }] }
	});

	const { questionId } = await asUser.mutation(api.agentQuestions.create, {
		runId,
		claimId,
		executionSecret,
		question: 'Which target?',
		options: [{ id: 'a', label: 'Target A' }]
	});

	return { asUser, threadId, runId, claimId, executionSecret, questionId };
}

describe('chat.selectedThreadLifecycle', { timeout: 20_000 }, () => {
	it('shows the latest completed run for a persisted thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		expect(await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).toMatchObject({
			threadId,
			phase: 'completed',
			run: { runId: expect.any(String) }
		});
	});
});

describe('durable run cancellation', { timeout: 30_000 }, () => {
	it('leaves the latest question answerable when an older completed run is stopped', async () => {
		const t = initConvexTest();
		const { asUser, threadId, questionId } = await runWithQuestion(t);

		const older = await t.run((ctx) =>
			ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.order('asc')
				.first()
		);

		if (!older) throw new Error('Older completed run missing.');
		expect(older.status).toBe('completed');
		expect(await asUser.mutation(api.agentRuntime.requestCancellation, { runId: older._id })).toBe(
			false
		);
		expect((await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).phase).toBe(
			'waiting_for_input'
		);
		expect(await asUser.query(api.agentQuestions.headPendingForThread, { threadId })).toMatchObject(
			{
				questionId
			}
		);
		await asUser.mutation(api.agentQuestions.answer, { threadId, questionId, optionId: 'a' });
		expect((await t.run((ctx) => ctx.db.get('agentQuestions', questionId)))?.status).toBe(
			'answered'
		);
	});

	it('immediately cancels questions on ordinary Stop and keeps them cancelled after resuming', async () => {
		const t = initConvexTest();

		const { asUser, threadId, runId, claimId, executionSecret, questionId } =
			await runWithQuestion(t);

		expect((await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).phase).toBe(
			'waiting_for_input'
		);
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId });
		expect(await asUser.query(api.agentQuestions.headPendingForThread, { threadId })).toBeNull();
		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId,
				optionId: 'a'
			})
		).rejects.toThrow(/no longer awaiting/);
		await expect(
			asUser.mutation(api.agentQuestions.create, {
				runId,
				claimId,
				executionSecret,
				question: 'Another?',
				options: [{ id: 'a', label: 'A' }]
			})
		).rejects.toThrow(/cancelled/);
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			expectedClaimId: claimId,
			executionSecret,
			status: 'cancelled',
			text: ''
		});
		await createQueuedRun(t, asUser, threadId, 'resumed-task', 'new-secret');
		expect((await t.run((ctx) => ctx.db.get('agentQuestions', questionId)))?.status).toBe(
			'cancelled'
		);
		expect(await asUser.query(api.agentQuestions.headPendingForThread, { threadId })).toBeNull();
	});

	it('keeps completed question-waiting threads active until Stop and leaves descendant questions alone', async () => {
		const t = initConvexTest();

		const { asUser, threadId, runId, claimId, executionSecret, questionId } =
			await runWithQuestion(t);

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			expectedClaimId: claimId,
			executionSecret,
			status: 'completed',
			text: 'Waiting for your choice.'
		});
		expect((await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).phase).toBe(
			'waiting_for_input'
		);
		await expect(asUser.mutation(api.threads.settle, { threadId })).rejects.toThrow(/active work/);
		const child = await runWithQuestion(t, threadId);
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId });
		expect((await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).phase).toBe(
			'completed'
		);
		expect(await asUser.query(api.agentQuestions.headPendingForThread, { threadId })).toBeNull();
		expect((await t.run((ctx) => ctx.db.get('agentQuestions', questionId)))?.status).toBe(
			'cancelled'
		);
		expect(
			(
				await child.asUser.query(api.agentQuestions.headPendingForThread, {
					threadId: child.threadId
				})
			)?.questionId
		).toBe(child.questionId);
		await expect(asUser.mutation(api.threads.settle, { threadId })).rejects.toThrow(/active work/);
		await child.asUser.mutation(api.agentRuntime.requestCancellation, { runId: child.runId });
		await child.asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: child.runId,
			expectedClaimId: child.claimId,
			executionSecret: child.executionSecret,
			status: 'cancelled',
			text: ''
		});
		expect(await asUser.query(api.threads.subtreeSummaryForThread, { threadId })).toMatchObject({
			descendantCount: 1,
			anyActive: false
		});
		await asUser.mutation(api.threads.settle, { threadId });
	});

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

			await ctx.db.insert('machines', {
				userId: run.userId,
				machineId: 'install-lifecycle',
				friendlyName: 'Workshop',
				platform: 'linux',
				platformVersion: '6.12.1',
				architecture: 'x86_64',
				hostname: 'workbench',
				appVersion: '0.3.2',
				credentialHash: 'a'.repeat(64),
				runIds: [created.runId],
				createdAt: Date.now(),
				updatedAt: Date.now()
			});
			await ctx.db.patch('runs', created.runId, { machineId: 'install-lifecycle' });
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

		expect(
			await asUser.mutation(api.agentRuntime.requestCancellation, { runId: created.runId })
		).toBe(true);
		expect(
			await asUser.mutation(api.agentRuntime.requestCancellation, { runId: created.runId })
		).toBe(true);
		const requested = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(requested?.cancellationRequestedAt).toEqual(expect.any(Number));
		expect(requested?.cancellationDeadlineAt).toBe(
			(requested?.cancellationRequestedAt ?? 0) + CANCELLATION_FORCE_AFTER_MS
		);
		expect(requested?.status).toBe('running');
		expect(await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).toMatchObject({
			phase: 'cancellation_requested'
		});
		// The executor observes the request immediately so it can stop its current
		// model or tool operation and acknowledge the cancellation.
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
				...toolTranscriptAssignment(created.runId, 'claim-cancel'),
				kind: 'exec_command',
				payload: { cmd: 'true' },
				executionSecret
			})
		).rejects.toThrow('Run is cancelled.');

		expect(await t.mutation(internal.runLifecycle.forceCancelRun, { runId: created.runId })).toBe(
			false
		);
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', created.runId, { cancellationDeadlineAt: Date.now() - 1 });
		});
		expect(await t.mutation(internal.runLifecycle.forceCancelRun, { runId: created.runId })).toBe(
			true
		);
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
		).toMatchObject({ accepted: true });
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', completed.runId))?.status)).toBe(
			'completed'
		);
		expect(await t.mutation(internal.runLifecycle.forceCancelRun, { runId: completed.runId })).toBe(
			false
		);

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
		).toMatchObject({ accepted: true });
		expect(await t.run(async (ctx) => ctx.db.get('runs', failed.runId))).toMatchObject({
			status: 'cancelled',
			lastError: 'model exploded'
		});
	});
});
