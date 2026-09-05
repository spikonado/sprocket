import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

describe('numbered transcript parts', () => {
	it('assigns contiguous zero-based numbers to prompts and is idempotent on retry', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const first = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-prompt-1',
			'transcript-prompt-secret',
			'Hello'
		);
		const retry = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-prompt-1',
			'transcript-prompt-secret',
			'Hello'
		);
		expect(retry.runId).toBe(first.runId);

		const state = await asUser.query(api.transcript.getState, { threadId });
		expect(state.totalParts).toBe(1);
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0] });
		expect(parts.parts).toHaveLength(1);
		expect(parts.parts[0]).toMatchObject({
			number: 0,
			kind: 'prompt',
			prompt: { text: 'Hello', imageUploads: [] }
		});
	});

	it('finalizes a successful completion call as one numbered record', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-complete-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-complete',
			executionSecret,
			'Write code'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-complete',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-complete',
			attemptSeq: 1,
			executionSecret
		});
		const items = [
			{
				type: 'reasoning' as const,
				id: 'stream-1:reasoning:a',
				text: 'Thinking',
				turnId: 'stream-1',
				startedAt: 1_000,
				completedAt: 2_000
			},
			{
				type: 'text' as const,
				id: 'stream-1:text:a',
				text: 'Working',
				turnId: 'stream-1',
				startedAt: 2_000,
				completedAt: 3_000
			},
			{
				type: 'tool-call' as const,
				partId: 'stream-1:tool:c1',
				callId: 'c1',
				name: 'exec_command',
				input: { cmd: 'ls' },
				turnId: 'stream-1',
				startedAt: 3_000,
				completedAt: 3_100
			}
		];
		const number = await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-complete',
			attemptSeq: 1,
			streamId: 'stream-1',
			items,
			executionSecret
		});
		expect(number).toBe(1);
		const again = await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-complete',
			attemptSeq: 1,
			streamId: 'stream-1',
			items,
			executionSecret
		});
		expect(again).toBe(1);
		const state = await asUser.query(api.transcript.getState, { threadId });
		expect(state.totalParts).toBe(2);
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion']);
		expect(parts.parts[1]?.completion?.items).toEqual(items);
	});

	it('normalizes missing timing from older agents on new completion writes', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-no-begin-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-no-begin',
			executionSecret,
			'Hello'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-no-begin',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-no-begin',
			attemptSeq: 1,
			executionSecret
		});
		const number = await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-no-begin',
			attemptSeq: 1,
			streamId: 'stream-1',
			items: [{ type: 'text' as const, id: 't', text: 'Hi', turnId: 'stream-1' }],
			executionSecret
		});
		expect(number).toBe(1);
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion']);
		const stored = await t.run(
			async (ctx) => await ctx.db.get('threadTranscriptParts', parts.parts[1]!._id)
		);
		expect(stored?.completion?.items).toEqual([
			{ type: 'text', id: 't', text: 'Hi', turnId: 'stream-1', startedAt: null, completedAt: null }
		]);
		expect(parts.parts[1]?.completion?.items).toEqual([
			{ type: 'text', id: 't', text: 'Hi', turnId: 'stream-1' }
		]);
		const agentParts = await t.query(api.transcript.getPartsForRun, {
			runId,
			executionSecret,
			numbers: [1]
		});
		expect(agentParts.parts[0]?.completion?.items).toEqual(parts.parts[1]?.completion?.items);
	});

	it('appends started and finished tool events paired by invocation id', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-tool-order-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-tool-order',
			executionSecret,
			'Use a tool'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-tool-order',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-tool-order',
			attemptSeq: 1,
			executionSecret
		});
		const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
			claimId: 'claim-tool-order',
			runId,
			kind: 'exec_command',
			callId: 'c1',
			payload: { cmd: 'echo hi' },
			executionSecret
		});
		const afterStart = await asUser.query(api.transcript.getState, { threadId });
		expect(afterStart.totalParts).toBe(2);
		const startedParts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		const started = startedParts.parts[1];
		const invocationId = started?.tool?.toolInvocationId;
		expect(started).toMatchObject({
			kind: 'tool',
			sourceKey: `tool:${invocationId}:started`,
			tool: {
				callId: 'c1',
				name: 'exec_command',
				status: 'started'
			}
		});
		expect(started?.tool?.jobId).toBeUndefined();
		expect(started?.tool?.output).toBeUndefined();
		const storedJob = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(storedJob?.toolInvocationId).toBe(invocationId);

		await asUser.mutation(api.executor.complete, {
			jobId,
			runId,
			claimId: 'claim-tool-order',
			executionSecret,
			result: {
				command: 'echo hi',
				cwd: '/',
				exitCode: 0,
				success: true,
				running: false,
				timedOut: false,
				output: 'hi',
				truncated: false
			}
		});
		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(3);
		await asUser.mutation(api.executor.complete, {
			jobId,
			runId,
			claimId: 'claim-tool-order',
			executionSecret,
			result: {
				command: 'echo hi',
				cwd: '/',
				exitCode: 0,
				success: true,
				running: false,
				timedOut: false,
				output: 'ignored',
				truncated: false
			}
		});
		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(3);
		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-tool-order',
			attemptSeq: 1,
			streamId: 'stream-tool',
			items: [
				{
					type: 'tool-call',
					partId: 'stream-tool:tool:c1',
					callId: 'c1',
					name: 'exec_command',
					input: { cmd: 'echo hi' },
					turnId: 'stream-tool'
				}
			],
			executionSecret
		});
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2, 3] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'tool', 'tool', 'completion']);
		expect(parts.parts[2]).toMatchObject({
			sourceKey: `tool:${invocationId}:finished`,
			tool: {
				toolInvocationId: invocationId,
				callId: 'c1',
				status: 'completed'
			}
		});
		expect(parts.parts[2]?.tool?.jobId).toBeUndefined();
	});

	it('records one cancelled finished event and ignores a later complete', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-tool-cancel-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-tool-cancel',
			executionSecret,
			'Use a tool'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-tool-cancel',
			runId,
			executionSecret
		});
		const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
			claimId: 'claim-tool-cancel',
			runId,
			kind: 'exec_command',
			callId: 'c-cancel',
			payload: { cmd: 'sleep 10' },
			executionSecret
		});
		const started = await asUser.query(api.transcript.getParts, { threadId, numbers: [1] });
		const invocationId = started.parts[0]?.tool?.toolInvocationId;
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId,
			expectedStatus: 'awaiting_executor',
			expectedClaimId: 'claim-tool-cancel',
			text: '',
			status: 'cancelled'
		});
		const afterCancel = await asUser.query(api.transcript.getState, { threadId });
		expect(afterCancel.totalParts).toBe(3);
		const finished = await asUser.query(api.transcript.getParts, { threadId, numbers: [2] });
		expect(finished.parts[0]).toMatchObject({
			sourceKey: `tool:${invocationId}:finished`,
			tool: {
				toolInvocationId: invocationId,
				callId: 'c-cancel',
				status: 'cancelled'
			}
		});
		await asUser.mutation(api.executor.complete, {
			jobId,
			runId,
			claimId: 'claim-tool-cancel',
			executionSecret,
			result: {
				command: 'sleep 10',
				cwd: '/',
				exitCode: 0,
				success: true,
				running: false,
				timedOut: false,
				output: '',
				truncated: false
			}
		});
		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(3);
		const job = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(job?.status).toBe('cancelled');
	});

	it('does not write transcript events for hidden tool jobs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-hidden-tool-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-hidden-tool',
			executionSecret,
			'Hide it'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-hidden-tool',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.beginToolJob, {
			claimId: 'claim-hidden-tool',
			runId,
			kind: 'exec_command',
			callId: 'hidden',
			payload: { cmd: 'true' },
			hidden: true,
			executionSecret
		});
		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(1);
	});

	it('only reads jobs named by the current completion call', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-exact-tool-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-exact-tool',
			executionSecret,
			'Use one tool'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-exact-tool',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-exact-tool',
			attemptSeq: 1,
			executionSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('executorJobs', {
				threadId,
				runId,
				kind: 'exec_command',
				callId: 'unrelated',
				payload: { cmd: 'echo unrelated' },
				hidden: false,
				status: 'completed',
				enqueuedAt: 1,
				completedAt: 2,
				result: {
					command: 'echo unrelated',
					cwd: '/',
					exitCode: 0,
					success: true,
					running: false,
					timedOut: false,
					output: 'unrelated',
					truncated: false
				},
				sequence: 0
			});
		});

		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-exact-tool',
			attemptSeq: 1,
			streamId: 'stream-without-tool',
			items: [{ type: 'text', id: 'text', text: 'Done', turnId: 'stream-without-tool' }],
			executionSecret
		});

		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion']);
	});

	it('does not number a failed run partial completion', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-fail-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-fail',
			executionSecret,
			'Fail please'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-fail',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId,
			text: 'partial',
			status: 'failed',
			lastError: 'boom'
		});
		const state = await asUser.query(api.transcript.getState, { threadId });
		expect(state.totalParts).toBe(1);
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0] });
		expect(parts.parts[0]?.kind).toBe('prompt');
	});

	it('keeps numbered completions when a failed run continues as a new run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-continue-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-continue-parent',
			executionSecret,
			'Keep going'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-continue',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-continue',
			attemptSeq: 1,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-continue',
			attemptSeq: 1,
			streamId: 'stream-continue',
			items: [
				{
					type: 'text',
					id: 'stream-continue:text',
					text: 'Done step',
					turnId: 'stream-continue'
				}
			],
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId,
			text: '',
			status: 'failed',
			lastError: 'boom'
		});
		const continuation = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'sub-continue-child',
			executionSecret: 'continue-secret',
			prompt: '',
			continuationOfRunId: runId
		});
		expect(continuation.runId).not.toBe(runId);
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', runId))?.status)).toBe('failed');
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion']);
	});

	it('getParts preserves request order and skips missing numbers', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const first = await createQueuedRun(t, asUser, threadId, 'sub-a', 'secret-a', 'A');
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: first.runId,
			text: '',
			status: 'cancelled'
		});
		await createQueuedRun(t, asUser, threadId, 'sub-b', 'secret-b', 'B');
		const parts = await asUser.query(api.transcript.getParts, {
			threadId,
			numbers: [1, 0, 9]
		});
		expect(parts.parts.map((part) => [part.number, part.prompt?.text])).toEqual([
			[1, 'B'],
			[0, 'A']
		]);
	});

	it('rejects oversized getParts requests', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		await expect(
			asUser.query(api.transcript.getParts, {
				threadId,
				numbers: Array.from({ length: 101 }, (_, index) => index)
			})
		).rejects.toThrow(/at most 100/);
	});

	it('ensures transcript state exists on a thread with no parts', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			totalParts: 0
		});
		const ensured = await asUser.mutation(api.transcript.ensureMigrated, { threadId });
		expect(ensured.totalParts).toBe(0);
		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			totalParts: 0
		});
	});
});
