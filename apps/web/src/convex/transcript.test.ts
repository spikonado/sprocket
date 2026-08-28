import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';
import { groupLegacyResponseIntoRecords } from '@convex/lib/transcriptParts';
import type { Id } from '@convex/_generated/dataModel';

function runId(value: string): Id<'runs'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'runs'>;
}

function messageId(value: string): Id<'threadMessages'> {
	// SAFETY: fixture strings are only compared as opaque Convex document ids.
	return value as Id<'threadMessages'>;
}

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
		await asUser.mutation(api.agentRuntime.beginAssistantMessage, { runId, executionSecret });
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-complete',
			attemptSeq: 1,
			executionSecret
		});
		const items = [
			{ type: 'text' as const, id: 'stream-1:text:a', text: 'Working', turnId: 'stream-1' },
			{
				type: 'tool-call' as const,
				partId: 'stream-1:tool:c1',
				callId: 'c1',
				name: 'exec_command',
				input: { cmd: 'ls' },
				turnId: 'stream-1'
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
		expect(parts.parts[1]?.completion?.items).toHaveLength(2);
	});

	it('records a completion even when beginAssistantMessage was skipped', async () => {
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
	});

	it('numbers a settled tool after the matching completion call', async () => {
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
		await asUser.mutation(api.agentRuntime.beginAssistantMessage, { runId, executionSecret });
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
				stdout: 'hi',
				stderr: '',
				output: 'hi',
				truncated: false
			}
		});
		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(1);
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
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion', 'tool']);
		expect(parts.parts[2]?.tool?.callId).toBe('c1');
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
		await asUser.mutation(api.agentRuntime.beginAssistantMessage, { runId, executionSecret });
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

	it('keeps numbered completions when a failed run is reopened', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-reopen-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-reopen',
			executionSecret,
			'Keep going'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-reopen',
			runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.beginAssistantMessage, { runId, executionSecret });
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			runId,
			claimId: 'claim-reopen',
			attemptSeq: 1,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-reopen',
			attemptSeq: 1,
			streamId: 'stream-reopen',
			items: [
				{ type: 'text', id: 'stream-reopen:text', text: 'Done step', turnId: 'stream-reopen' }
			],
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId,
			text: '',
			status: 'failed',
			lastError: 'boom'
		});
		await asUser.mutation(api.agentRuntime.reopenRun, { runId });
		const run = await t.run(async (ctx) => ctx.db.get('runs', runId));
		expect(run?.status).toBe('queued');
		await expect(
			asUser.mutation(api.agentRuntime.start, {
				claimId: 'claim-reopen',
				runId,
				executionSecret
			})
		).rejects.toThrow('Run not found.');
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

	it('migrates legacy responses by grouping turnId and splitting tool results', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-migrate-secret';
		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-migrate',
			executionSecret,
			'Old prompt'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-migrate',
			runId: created.runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.beginAssistantMessage, {
			runId: created.runId,
			executionSecret
		});
		await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', created.runId);
			if (!run?.responseMessageId) throw new Error('missing response');
			await ctx.db.patch('threadMessages', run.responseMessageId, {
				text: 'done',
				parts: [
					{ type: 'text', id: 't1', text: 'first', turnId: 'turn-a' },
					{
						type: 'tool-call',
						callId: 'c1',
						name: 'exec_command',
						input: { cmd: 'ls' },
						turnId: 'turn-a'
					},
					{ type: 'tool-result', callId: 'c1', name: 'exec_command', output: 'ok' },
					{ type: 'text', id: 't2', text: 'second', turnId: 'turn-b' }
				]
			});
			await ctx.db.patch('runs', created.runId, {
				status: 'completed',
				completedAt: Date.now()
			});
			const states = await ctx.db
				.query('threadTranscriptStates')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (states) {
				const parts = await ctx.db
					.query('threadTranscriptParts')
					.withIndex('by_threadId_and_number', (query) => query.eq('threadId', threadId))
					.collect();
				for (const part of parts) {
					await ctx.db.delete('threadTranscriptParts', part._id);
				}
				await ctx.db.patch('threadTranscriptStates', states._id, {
					totalParts: 0,
					migratedAt: undefined
				});
			}
		});

		const migrated = await asUser.mutation(api.transcript.ensureMigrated, { threadId });
		expect(migrated.totalParts).toBe(4);
		const parts = await asUser.query(api.transcript.getParts, {
			threadId,
			numbers: [0, 1, 2, 3]
		});
		expect(parts.parts.map((part) => part.kind)).toEqual([
			'prompt',
			'completion',
			'tool',
			'completion'
		]);
	});

	it('skips failed legacy completions during migration', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'transcript-migrate-failed-secret';
		const created = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-migrate-failed',
			executionSecret,
			'Old prompt'
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-migrate-failed',
			runId: created.runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.beginAssistantMessage, {
			runId: created.runId,
			executionSecret
		});
		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId: created.runId,
			text: 'partial',
			status: 'failed',
			lastError: 'boom'
		});
		await t.run(async (ctx) => {
			const run = await ctx.db.get('runs', created.runId);
			if (!run?.responseMessageId) throw new Error('missing response');
			await ctx.db.patch('threadMessages', run.responseMessageId, {
				text: 'partial',
				parts: [{ type: 'text', id: 't1', text: 'partial', turnId: 'turn-a' }]
			});
			const states = await ctx.db
				.query('threadTranscriptStates')
				.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
				.unique();
			if (states) {
				const parts = await ctx.db
					.query('threadTranscriptParts')
					.withIndex('by_threadId_and_number', (query) => query.eq('threadId', threadId))
					.collect();
				for (const part of parts) {
					await ctx.db.delete('threadTranscriptParts', part._id);
				}
				await ctx.db.patch('threadTranscriptStates', states._id, {
					totalParts: 0,
					migratedAt: undefined
				});
			}
		});

		const migrated = await asUser.mutation(api.transcript.ensureMigrated, { threadId });
		expect(migrated.totalParts).toBe(1);
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt']);
	});
});

describe('groupLegacyResponseIntoRecords', () => {
	it('groups by turnId and emits tool records separately', () => {
		const records = groupLegacyResponseIntoRecords({
			runId: runId('run'),
			messageId: messageId('msg'),
			parts: [
				{ type: 'text', id: 't1', text: 'a', turnId: 'turn-1' },
				{ type: 'text', id: 't2', text: 'b', turnId: 'turn-1' },
				{ type: 'tool-result', callId: 'c1', name: 'exec_command', output: 'ok' },
				{ type: 'text', id: 't3', text: 'c', turnId: 'turn-2' }
			]
		});
		expect(records.map((record) => record.kind)).toEqual(['completion', 'tool', 'completion']);
	});

	it('emits a completion from text-only legacy responses with empty parts', () => {
		const records = groupLegacyResponseIntoRecords({
			runId: runId('run'),
			messageId: messageId('msg'),
			parts: [],
			text: 'Just words'
		});
		expect(records).toEqual([
			{
				kind: 'completion',
				sourceKey: 'completion:run:legacy:0',
				completion: {
					items: [{ type: 'text', id: 'legacy:msg:text', text: 'Just words' }]
				}
			}
		]);
	});
});
