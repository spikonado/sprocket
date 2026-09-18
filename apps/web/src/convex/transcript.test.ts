import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import {
	createQueuedRun,
	emptyCompletionAssignments,
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	toolTranscriptAssignment
} from './test.setup';

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
			}
		];
		const sectionKey = `agent:${runId}:claim-complete:1:section:1`;
		const assignments = {
			work: { ranges: [{ start: 0, end: 1, sectionKey }] },
			toolInvocations: [],
			sections: [{ sectionKey, sectionOrdinal: 1, closed: true }]
		};
		const number = await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-complete',
			attemptSeq: 1,
			streamId: 'stream-1',
			items,
			...assignments,
			executionSecret
		});
		expect(number?.number).toBe(1);
		const again = await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-complete',
			attemptSeq: 1,
			streamId: 'stream-1',
			items,
			...assignments,
			executionSecret
		});
		expect(again?._id).toBe(number?._id);
		const state = await asUser.query(api.transcript.getState, { threadId });
		expect(state.totalParts).toBe(2);
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion']);
		expect(parts.parts[1]?.completion?.items).toEqual(items);
	});

	it('accepts encrypted-only reasoning without a work assignment', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-empty-reasoning-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-empty-reasoning',
			executionSecret,
			'Write code'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-empty-reasoning',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-empty-reasoning',
			attemptSeq: 1,
			executionSecret
		});
		// Encrypted-only reasoning has no display text. The agent tracker skips it
		// as work while still persisting the envelope for replay.
		const items = [
			{
				type: 'reasoning' as const,
				id: 'stream-1:reasoning:empty',
				text: '',
				turnId: 'stream-1',
				providerMetadata: {
					openai: { itemId: 'rs_empty', reasoningEncryptedContent: 'envelope' }
				}
			},
			{
				type: 'reasoning' as const,
				id: 'stream-1:reasoning:visible',
				text: 'Thinking',
				turnId: 'stream-1'
			}
		];
		const sectionKey = `agent:${runId}:claim-empty-reasoning:1:section:1`;
		const part = await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-empty-reasoning',
			attemptSeq: 1,
			streamId: 'stream-1',
			items,
			work: { ranges: [{ start: 1, end: 2, sectionKey }] },
			toolInvocations: [],
			sections: [{ sectionKey, sectionOrdinal: 1, closed: true }],
			executionSecret
		});
		expect(part?.completion?.items).toHaveLength(2);

		// Empty reasoning must not carry work; visible reasoning must.
		await expect(
			asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
				runId,
				claimId: 'claim-empty-reasoning',
				attemptSeq: 1,
				streamId: 'stream-1-bad-work',
				items,
				work: { ranges: [{ start: 0, end: 2, sectionKey }] },
				toolInvocations: [],
				sections: [{ sectionKey, sectionOrdinal: 1, closed: true }],
				executionSecret
			})
		).rejects.toThrow('Invalid work assignment.');
	});

	it('normalizes missing timing on completion writes', async () => {
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
			...emptyCompletionAssignments,
			executionSecret
		});
		expect(number?.number).toBe(1);
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion']);
		const stored = await t.run(
			async (ctx) => await ctx.db.get('threadTranscriptParts', parts.parts[1]!._id)
		);
		const expectedItems = [
			{ type: 'text', id: 't', text: 'Hi', turnId: 'stream-1', startedAt: null, completedAt: null }
		];
		expect(stored?.completion?.items).toEqual(expectedItems);
		expect(parts.parts[1]?.completion?.items).toEqual(expectedItems);
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
			...toolTranscriptAssignment(runId, 'claim-tool-order', 1, 1, 'stream-tool'),
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
		expect(started?.tool?.output).toBeUndefined();
		const storedJob = await t.run(async (ctx) => ctx.db.get('executorJobs', jobId));
		expect(storedJob?.toolInvocationId).toBe(invocationId);

		await asUser.mutation(api.executor.complete, {
			jobId,
			runId,
			claimId: 'claim-tool-order',
			executionSecret,
			result: {
				output: 'hi',
				exitCode: 0,
				success: true,
				running: false,
				timedOut: false,
				completeLogPath: '/transcripts/command/output.log',
				eventsPath: '/transcripts/command/events.jsonl'
			}
		});
		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(3);
		await asUser.mutation(api.executor.complete, {
			jobId,
			runId,
			claimId: 'claim-tool-order',
			executionSecret,
			result: {
				output: 'ignored',
				exitCode: 0,
				success: true,
				running: false,
				timedOut: false,
				completeLogPath: '/transcripts/command/output.log',
				eventsPath: '/transcripts/command/events.jsonl'
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
			work: {
				ranges: [
					{
						start: 0,
						end: 1,
						sectionKey: `agent:${runId}:claim-tool-order:1:section:1`
					}
				]
			},
			toolInvocations: [
				{
					callId: 'c1',
					toolInvocationId: 'test-invocation-1',
					sectionKey: `agent:${runId}:claim-tool-order:1:section:1`
				}
			],
			sections: [
				{
					sectionKey: `agent:${runId}:claim-tool-order:1:section:1`,
					sectionOrdinal: 1,
					closed: false
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
			...toolTranscriptAssignment(runId, 'claim-tool-cancel'),
			kind: 'exec_command',
			callId: 'c-cancel',
			payload: { cmd: 'sleep 10' },
			executionSecret
		});
		const started = await asUser.query(api.transcript.getParts, { threadId, numbers: [1] });
		const invocationId = started.parts[0]?.tool?.toolInvocationId;
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			expectedStatus: 'running',
			expectedClaimId: 'claim-tool-cancel',
			text: '',
			status: 'cancelled',
			executionSecret
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
				output: '',
				exitCode: 0,
				success: true,
				running: false,
				timedOut: false,
				completeLogPath: '/transcripts/command/output.log',
				eventsPath: '/transcripts/command/events.jsonl'
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
			...toolTranscriptAssignment(runId, 'claim-hidden-tool'),
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
				toolInvocationId: 'test-invocation-unrelated',
				payload: { cmd: 'echo unrelated' },
				hidden: false,
				status: 'completed',
				enqueuedAt: 1,
				completedAt: 2,
				result: {
					output: 'unrelated',
					exitCode: 0,
					success: true,
					running: false,
					timedOut: false,
					completeLogPath: '/transcripts/command/output.log',
					eventsPath: '/transcripts/command/events.jsonl'
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
			...emptyCompletionAssignments,
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
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			text: 'partial',
			status: 'failed',
			lastError: 'boom',
			executionSecret
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
			...emptyCompletionAssignments,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			text: '',
			status: 'failed',
			lastError: 'boom',
			executionSecret
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
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: first.runId,
			text: '',
			status: 'cancelled',
			executionSecret: 'secret-a'
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

	it('returns zero totalParts for a thread with no transcript state row', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			totalParts: 0
		});
	});

	it('does not delete covered parts when a handoff cutoff advances historyFromNumber', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'handoff-keep-history-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-handoff-keep-history',
			executionSecret,
			'Keep this prompt visible'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-keep-history',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-keep-history',
			attemptSeq: 1,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-keep-history',
			attemptSeq: 1,
			streamId: 'stream-keep',
			items: [{ type: 'text' as const, id: 't', text: 'Covered work', turnId: 'stream-keep' }],
			...emptyCompletionAssignments,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-keep-history',
			attemptSeq: 2,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.saveContextHandoff, {
			runId,
			claimId: 'claim-keep-history',
			executionSecret,
			summary: 'Covered work is done.',
			completionAttemptSeq: 2,
			beforePrompt: false
		});
		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			totalParts: 2,
			historyFromNumber: 2,
			contextSummary: 'Covered work is done.'
		});
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts.map((part) => [part.number, part.kind])).toEqual([
			[0, 'prompt'],
			[1, 'completion']
		]);
	});
});

describe('transcript attachment identity', () => {
	it('returns storage-only attachment metadata', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const executionSecret = 'storage-only-parts-secret';
		const file = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['file'], { type: 'text/plain' }));
			const imageUploadId = await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId,
				name: 'file.txt',
				mediaType: 'text/plain',
				size: 4,
				attached: false
			});
			return { storageId, imageUploadId };
		});
		const created = await insertQueuedRun(t, asUser, {
			submissionId: 'storage-only-parts',
			threadId,
			prompt: 'Read this',
			imageUploadIds: [file.imageUploadId],
			executionSecret
		});

		const parts = await asUser.query(api.transcript.getParts, {
			threadId,
			numbers: [0]
		});
		expect(parts.parts[0]?.prompt?.imageUploads[0]).toEqual({
			name: 'file.txt',
			mediaType: 'text/plain',
			size: 4,
			storageId: file.storageId,
			url: expect.any(String)
		});
		expect(parts.parts[0]?.prompt?.imageUploads[0]).not.toHaveProperty('imageUploadId');

		const runParts = await t.query(api.transcript.getPartsForRun, {
			runId: created.runId,
			executionSecret,
			numbers: [0]
		});
		expect(runParts.parts[0]?.prompt?.imageUploads[0]).not.toHaveProperty('imageUploadId');
	});

	it('downloads an owned file by storageId and hides foreign files', async () => {
		const t = initConvexTest();
		const { asUser, subject } = await seedOwnedThread(t);
		const bob = t.withIdentity({ subject: 'bob' });
		const file = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['file'], { type: 'text/plain' }));
			await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId,
				name: 'file.txt',
				mediaType: 'text/plain',
				size: 4,
				attached: false
			});
			return storageId;
		});
		expect(
			await asUser.query(api.transcript.attachmentDownloadByStorageId, { storageId: file })
		).toMatchObject({
			storageId: file,
			name: 'file.txt',
			mediaType: 'text/plain',
			size: 4
		});
		expect(await bob.query(api.transcript.attachmentDownloadByStorageId, { storageId: file })).toBe(
			null
		);
	});
});
