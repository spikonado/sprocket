import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { QueryCtx } from '@convex/_generated/server';
import { executionSecretHash } from '@convex/lib/auth';
import { appendTranscriptPart } from '@convex/lib/transcriptParts';
import { beginExecutorJob } from '@convex/lib/toolJobs';
import {
	createQueuedRun,
	emptyCompletionAssignments,
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	toolTranscriptAssignment,
	type ConvexTestInstance
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
			kind: 'exec_cmd',
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
				name: 'exec_cmd',
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
					name: 'exec_cmd',
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

	it('persists a tool call before its job starts', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-call-first-secret';
		const claimId = 'claim-call-first';

		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-call-first',
			executionSecret,
			'Use a tool'
		);

		await asUser.mutation(api.agentRuntime.start, { claimId, runId, executionSecret });
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId,
			attemptSeq: 1,
			executionSecret
		});

		const assignment = toolTranscriptAssignment(runId, claimId, 1, 1, 'stream-tool');

		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId,
			attemptSeq: 1,
			streamId: 'stream-tool',
			items: [
				{
					type: 'tool-call',
					partId: 'stream-tool:tool:c1',
					callId: 'c1',
					name: 'exec_cmd',
					input: { cmd: 'echo hi' },
					turnId: 'stream-tool'
				}
			],
			work: { ranges: [{ start: 0, end: 1, sectionKey: assignment.sectionKey }] },
			toolInvocations: [
				{
					callId: 'c1',
					toolInvocationId: assignment.toolInvocationId,
					sectionKey: assignment.sectionKey
				}
			],
			sections: [{ sectionKey: assignment.sectionKey, sectionOrdinal: 1, closed: false }],
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.beginToolJob, {
			claimId,
			runId,
			...assignment,
			kind: 'exec_cmd',
			callId: 'c1',
			payload: { cmd: 'echo hi' },
			executionSecret
		});

		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion', 'tool']);
		expect(parts.parts[2]?.tool).toMatchObject({ callId: 'c1', status: 'started' });
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
			kind: 'exec_cmd',
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
				status: 'cancelled',
				output: {
					status: 'cancelled',
					error: 'Run was stopped before executor job completed.'
				}
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

	it.each([undefined, true])(
		'records artifact work and results with stored legacy hidden=%s',
		async (hidden) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const executionSecret = 'transcript-artifact-secret';

			const { runId } = await createQueuedRun(
				t,
				asUser,
				threadId,
				'sub-artifact',
				executionSecret,
				'List artifacts'
			);

			await asUser.mutation(api.agentRuntime.start, {
				claimId: 'claim-artifact',
				runId,
				executionSecret
			});
			const assignment = toolTranscriptAssignment(runId, 'claim-artifact');

			const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
				claimId: 'claim-artifact',
				runId,
				...assignment,
				kind: 'list_artifacts',
				callId: 'artifacts',
				payload: {},
				executionSecret
			});

			await t.run((ctx) => ctx.db.patch('executorJobs', jobId, { hidden }));

			expect(
				await t.run((ctx) => ctx.db.query('threadTranscriptWorkSections').unique())
			).toMatchObject({ key: assignment.sectionKey, itemCount: 1, pendingTools: 1 });
			await asUser.mutation(api.executor.complete, {
				jobId,
				runId,
				claimId: 'claim-artifact',
				executionSecret,
				result: { artifacts: [] }
			});
			await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
				runId,
				claimId: 'claim-artifact',
				executionSecret,
				attemptSeq: assignment.attemptSeq,
				streamId: assignment.streamId,
				items: [{ type: 'tool-call', callId: 'artifacts', name: 'list_artifacts', input: {} }],
				work: { ranges: [{ start: 0, end: 1, sectionKey: assignment.sectionKey }] },
				toolInvocations: [
					{
						callId: 'artifacts',
						toolInvocationId: assignment.toolInvocationId,
						sectionKey: assignment.sectionKey
					}
				],
				sections: [
					{
						sectionKey: assignment.sectionKey,
						sectionOrdinal: assignment.sectionOrdinal,
						closed: false
					}
				]
			});

			const parts = await asUser.query(api.transcript.getPartsForRun, {
				runId,
				executionSecret,
				numbers: [0, 1, 2, 3, 4]
			});

			expect(parts.parts.map((part) => part.kind)).toEqual([
				'prompt',
				'tool',
				'tool',
				'completion'
			]);
			expect(parts.parts[2]).toMatchObject({
				tool: {
					callId: 'artifacts',
					name: 'list_artifacts',
					status: 'completed',
					output: { artifacts: [] }
				},
				work: { ranges: [], sectionKey: assignment.sectionKey }
			});
			expect(
				await t.run((ctx) => ctx.db.query('threadTranscriptWorkSections').unique())
			).toMatchObject({ key: assignment.sectionKey, itemCount: 1, pendingTools: 0 });
		}
	);

	it('reconciles sectionless historical artifact jobs and persists their results', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'legacy-artifact-secret';

		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'legacy-artifact',
			executionSecret,
			'List artifacts'
		);

		const auth = { runId, claimId: 'legacy-artifact', executionSecret };
		await asUser.mutation(api.agentRuntime.start, auth);

		const { jobId } = await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', runId);

			if (!run) throw new Error('Missing run fixture.');

			return await beginExecutorJob(ctx, {
				run,
				claimId: auth.claimId,
				...toolTranscriptAssignment(runId, auth.claimId),
				sectionKey: undefined,
				kind: 'list_artifacts',
				callId: 'legacy-artifacts',
				payload: {}
			});
		});

		await asUser.mutation(api.executor.complete, { ...auth, jobId, result: { artifacts: [] } });
		await asUser.mutation(api.executor.complete, { ...auth, jobId, result: { artifacts: [] } });

		const parts = await asUser.query(api.transcript.getPartsForRun, {
			runId,
			executionSecret,
			numbers: [1, 2]
		});

		expect(parts.parts.map((part) => part.tool?.status)).toEqual(['started', 'completed']);
		expect(parts.parts[1]?.tool?.output).toEqual({ artifacts: [] });
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

describe('transcript range reads', () => {
	async function seedParts(t: ConvexTestInstance, numbers: number[], text = '') {
		const owned = await seedOwnedThread(t);
		const executionSecret = 'range-parts-secret';

		const runId = await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId', (q) => q.eq('threadId', owned.threadId))
				.unique();

			if (!run) throw new Error('Missing fixture run.');

			await ctx.db.patch('runs', run._id, {
				executionSecretHash: await executionSecretHash(executionSecret)
			});

			for (const number of numbers) {
				await ctx.db.insert('threadTranscriptParts', {
					threadId: owned.threadId,
					runId: run._id,
					number,
					sourceKey: `prompt:${number}`,
					kind: 'prompt',
					prompt: { text: `Part ${number}${text}`, imageUploads: [] },
					work: { ranges: [] }
				});
			}

			return run._id;
		});

		return { ...owned, runId, executionSecret };
	}

	it.each([undefined, 'asc', 'desc'] as const)(
		'returns at most 100 parts in order %s',
		async (order) => {
			const t = initConvexTest();

			const { asUser, threadId, runId, executionSecret } = await seedParts(
				t,
				Array.from({ length: 104 }, (_, number) => number)
			);

			const page = await asUser.query(api.transcript.getPartsPage, {
				threadId,
				start: 1,
				end: 103,
				order
			});

			expect(page.threadId).toBe(threadId);
			expect(page.parts.map((part) => part.number)).toEqual(
				Array.from({ length: 100 }, (_, index) => (order === 'asc' ? index + 1 : 102 - index))
			);
			expect(
				await t.query(api.transcript.getPartsPageForRun, {
					runId,
					executionSecret,
					start: 1,
					end: 103,
					order
				})
			).toEqual(page);
		}
	);

	it.each([
		{ caller: 'owner', order: 'desc' },
		{ caller: 'owner', order: 'asc' },
		{ caller: 'run', order: 'desc' },
		{ caller: 'run', order: 'asc' }
	] as const)(
		'resumes byte-limited $caller pages in $order order without gaps or live appends',
		async ({ caller, order }) => {
			const t = initConvexTest();
			const numbers = Array.from({ length: 8 }, (_, number) => number);

			const { asUser, threadId, runId, executionSecret } = await seedParts(
				t,
				numbers,
				'x'.repeat(400_000)
			);

			const readPage = (ctx: QueryCtx, start: number, end: number) =>
				caller === 'owner'
					? ctx.runQuery(api.transcript.getPartsPage, { threadId, start, end, order })
					: ctx.runQuery(api.transcript.getPartsPageForRun, {
							runId,
							executionSecret,
							start,
							end,
							order
						});

			const measured = await asUser.query(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();

				const result = await readPage(ctx, 0, numbers.length);

				const after = await ctx.meta.getTransactionMetrics();

				return { result, bytes: after.bytesRead.used - before.bytesRead.used };
			});

			expect(measured.result.parts.length).toBeGreaterThan(0);
			expect(measured.result.parts.length).toBeLessThan(numbers.length);
			expect(measured.bytes).toBeGreaterThanOrEqual(1_000_000);
			// Pagination includes the document that crosses the byte target.
			expect(measured.bytes).toBeLessThan(1_500_000);
			await t.run((ctx) =>
				ctx.db.insert('threadTranscriptParts', {
					threadId,
					runId,
					number: numbers.length,
					sourceKey: 'prompt:live',
					kind: 'prompt',
					prompt: { text: 'Appended live', imageUploads: [] },
					work: { ranges: [] }
				})
			);

			const fetched: number[] = [];
			let page = measured.result;
			let start = 0;
			let end = numbers.length;

			for (let attempt = 0; attempt < numbers.length && start < end; attempt++) {
				expect(page.parts.map((part) => part.number)).toEqual(
					Array.from({ length: page.parts.length }, (_, index) =>
						order === 'asc' ? start + index : end - 1 - index
					)
				);
				fetched.push(...page.parts.map((part) => part.number));
				expect(page.parts.length).toBeGreaterThan(0);
				const lastNumber = page.parts.at(-1)!.number;

				if (order === 'asc') start = lastNumber + 1;
				else end = lastNumber;

				if (start < end) {
					page = await asUser.query((ctx) => readPage(ctx, start, end));
				}
			}

			expect(start).toBe(end);
			expect(fetched).toEqual(order === 'asc' ? numbers : numbers.toReversed());

			const live = await asUser.query((ctx) => readPage(ctx, numbers.length, numbers.length + 1));

			expect(live.parts.map((part) => part.number)).toEqual([numbers.length]);
		}
	);

	it('requires the requested run execution secret to fetch a page', async () => {
		const t = initConvexTest();
		const first = await seedParts(t, [0]);
		const second = await seedParts(t, [0]);
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', second.runId, {
				executionSecretHash: await executionSecretHash('second-secret')
			});
		});

		const args = { runId: first.runId, executionSecret: first.executionSecret, start: 0, end: 1 };
		expect(await t.query(api.transcript.getPartsPageForRun, args)).toMatchObject({
			threadId: first.threadId,
			parts: [{ number: 0, threadId: first.threadId }]
		});
		await expect(
			t.query(api.transcript.getPartsPageForRun, { ...args, executionSecret: 'wrong' })
		).rejects.toThrow('Run not found.');
		await expect(
			t.query(api.transcript.getPartsPageForRun, { ...args, runId: second.runId })
		).rejects.toThrow('Run not found.');
	});

	it.each([
		{ start: -1, end: 1 },
		{ start: 0.5, end: 1 },
		{ start: 1, end: 1 },
		{ start: 2, end: 1 },
		{ start: 0, end: 1.5 },
		{ start: 0, end: Number.MAX_SAFE_INTEGER + 1 }
	])('rejects invalid page range $start..$end', async (range) => {
		const t = initConvexTest();
		const { asUser, threadId, runId, executionSecret } = await seedParts(t, [0]);
		await expect(asUser.query(api.transcript.getPartsPage, { threadId, ...range })).rejects.toThrow(
			'Invalid transcript range.'
		);
		await expect(
			t.query(api.transcript.getPartsPageForRun, { runId, executionSecret, ...range })
		).rejects.toThrow('Invalid transcript range.');
	});

	it('requires the thread owner to fetch a page', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedParts(t, [0]);
		const args = { threadId, start: 0, end: 1 };

		expect((await asUser.query(api.transcript.getPartsPage, args)).parts).toHaveLength(1);
		await expect(
			t.withIdentity({ subject: 'bob' }).query(api.transcript.getPartsPage, args)
		).rejects.toThrow('Thread not found.');
		await expect(t.query(api.transcript.getPartsPage, args)).rejects.toThrow(
			'Authentication required.'
		);
	});
});

describe('transcript attachment identity', () => {
	async function seedAttachedPrompt(t: ConvexTestInstance) {
		const owned = await seedOwnedThread(t);
		const { asUser, subject, threadId } = owned;
		const executionSecret = `storage-only-parts-secret-${threadId}`;

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
			submissionId: `storage-only-parts-${threadId}`,
			threadId,
			prompt: 'Read this',
			imageUploadIds: [file.imageUploadId],
			executionSecret
		});

		return { ...owned, file, runId: created.runId, executionSecret };
	}

	it('hydrates legacy number endpoints but leaves page attachment URLs unresolved', async () => {
		const t = initConvexTest();
		const { asUser, threadId, file, runId, executionSecret } = await seedAttachedPrompt(t);

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

		const runParts = await t.query(api.transcript.getPartsForRun, {
			runId,
			executionSecret,
			numbers: [0]
		});

		expect(runParts).toEqual(parts);

		const page = await asUser.query(api.transcript.getPartsPage, { threadId, start: 0, end: 1 });
		expect(page.parts[0]?.prompt?.imageUploads).toEqual([
			{
				name: 'file.txt',
				mediaType: 'text/plain',
				size: 4,
				storageId: file.storageId
			}
		]);
		expect(
			await t.query(api.transcript.getPartsPageForRun, { runId, executionSecret, start: 0, end: 1 })
		).toEqual(page);
	});

	it('returns the requested attachment URL and null for deleted storage', async () => {
		const t = initConvexTest();
		const { runId, executionSecret, file } = await seedAttachedPrompt(t);
		const args = { runId, executionSecret, partNumber: 0, storageId: file.storageId };
		expect(await t.query(api.transcript.attachmentUrlForRun, args)).toEqual(expect.any(String));
		await t.run((ctx) => ctx.storage.delete(file.storageId));
		expect(await t.query(api.transcript.attachmentUrlForRun, args)).toBeNull();
	});

	it('restricts the attachment URL to the exact prompt part and run capability', async () => {
		const t = initConvexTest();
		const first = await seedAttachedPrompt(t);
		const other = await seedAttachedPrompt(t);
		await t.run(async (ctx) => {
			await appendTranscriptPart(ctx, {
				threadId: first.threadId,
				runId: first.runId,
				sourceKey: 'prompt:without-attachments',
				kind: 'prompt',
				prompt: { text: 'No attachments', imageUploads: [] },
				work: { ranges: [] }
			});
			await appendTranscriptPart(ctx, {
				threadId: first.threadId,
				runId: first.runId,
				sourceKey: 'tool:without-attachments',
				kind: 'tool',
				tool: {
					toolInvocationId: 'invocation',
					callId: 'call',
					name: 'exec_cmd',
					status: 'completed'
				},
				work: { ranges: [] }
			});
		});

		const args = {
			runId: first.runId,
			executionSecret: first.executionSecret,
			partNumber: 0,
			storageId: first.file.storageId
		};

		await expect(
			t.query(api.transcript.attachmentUrlForRun, { ...args, executionSecret: 'wrong' })
		).rejects.toThrow('Run not found.');
		await expect(
			t.query(api.transcript.attachmentUrlForRun, { ...args, runId: other.runId })
		).rejects.toThrow('Run not found.');
		await expect(
			t.query(api.transcript.attachmentUrlForRun, {
				...args,
				storageId: other.file.storageId
			})
		).rejects.toThrow('Attachment not found in transcript part.');
		await expect(
			t.query(api.transcript.attachmentUrlForRun, { ...args, partNumber: 1 })
		).rejects.toThrow('Attachment not found in transcript part.');

		for (const partNumber of [2, 3]) {
			await expect(
				t.query(api.transcript.attachmentUrlForRun, { ...args, partNumber })
			).rejects.toThrow('Transcript prompt part not found.');
		}

		for (const partNumber of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(
				t.query(api.transcript.attachmentUrlForRun, { ...args, partNumber })
			).rejects.toThrow('Invalid transcript part number.');
		}
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
