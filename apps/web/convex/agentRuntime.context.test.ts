import { describe, expect, it } from 'vitest';
import { patchRunExecution } from '@convex/lib/runExecution';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { appendTranscriptPart } from '@convex/lib/transcriptParts';
import { getThreadUsageValues } from '@convex/lib/threadUsage';
import {
	createQueuedRun,
	emptyCompletionAssignments,
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	type ConvexTestInstance
} from './test.setup';

async function readThreadUsage(t: ConvexTestInstance, threadId: Id<'threadRecords'>) {
	return await t.run(async (ctx) => {
		const thread = await ctx.db.get('threadRecords', threadId);
		if (!thread) return null;
		return await getThreadUsageValues(ctx, thread);
	});
}

async function readThreadCutoff(t: ConvexTestInstance, threadId: Id<'threadRecords'>) {
	return await t.run(async (ctx) => {
		const thread = await ctx.db.get('threadRecords', threadId);
		return {
			contextSummary: thread?.contextSummary,
			contextSummaryThroughPartNumber: thread?.contextSummaryThroughPartNumber
		};
	});
}

async function finalizeTextCompletion(
	asUser: ReturnType<ConvexTestInstance['withIdentity']>,
	args: {
		runId: Id<'runs'>;
		claimId: string;
		executionSecret: string;
		attemptSeq: number;
		streamId: string;
		text: string;
		usage?: { contextTokens: number; processedTokens: number };
	}
) {
	await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
		runId: args.runId,
		claimId: args.claimId,
		attemptSeq: args.attemptSeq,
		executionSecret: args.executionSecret
	});
	return await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
		runId: args.runId,
		claimId: args.claimId,
		attemptSeq: args.attemptSeq,
		streamId: args.streamId,
		items: [
			{
				type: 'text' as const,
				id: `${args.streamId}:text`,
				text: args.text,
				turnId: args.streamId
			}
		],
		...emptyCompletionAssignments,
		usage: args.usage,
		executionSecret: args.executionSecret
	});
}

async function registerCompletionAttempt(
	asUser: ReturnType<ConvexTestInstance['withIdentity']>,
	args: {
		runId: Id<'runs'>;
		claimId: string;
		executionSecret: string;
		attemptSeq: number;
	}
) {
	await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
		runId: args.runId,
		claimId: args.claimId,
		attemptSeq: args.attemptSeq,
		executionSecret: args.executionSecret
	});
}

async function appendFinishedToolPart(
	t: ConvexTestInstance,
	args: { threadId: Id<'threadRecords'>; runId: Id<'runs'>; invocationId: string }
) {
	await t.run(async (ctx) => {
		await appendTranscriptPart(ctx, {
			threadId: args.threadId,
			userId: 'user_alice',
			sourceKey: `tool:${args.invocationId}:finished`,
			kind: 'tool',
			runId: args.runId,
			tool: {
				toolInvocationId: args.invocationId,
				callId: args.invocationId,
				name: 'exec_command',
				status: 'completed'
			},
			work: { ranges: [], sectionKey: `test-tool:${args.runId}:${args.invocationId}` }
		});
	});
}

describe('agentRuntime context accounting', () => {
	it('records usage atomically with a durable completion', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'finalized-context-usage-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'finalized-context-usage',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-finalized-usage',
			executionSecret
		});

		await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-finalized-usage',
			executionSecret,
			attemptSeq: 1,
			streamId: 'stream-finalized-usage',
			text: 'Done',
			usage: { contextTokens: 8_000, processedTokens: 9_000 }
		});
		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			runId,
			claimId: 'claim-finalized-usage',
			attemptSeq: 1,
			streamId: 'stream-finalized-usage',
			items: [
				{
					type: 'text',
					id: 'stream-finalized-usage:text',
					text: 'Done',
					turnId: 'stream-finalized-usage'
				}
			],
			...emptyCompletionAssignments,
			usage: { contextTokens: 8_000, processedTokens: 9_000 },
			executionSecret
		});

		expect(await readThreadUsage(t, threadId)).toMatchObject({
			contextTokens: 8_000,
			totalTokensProcessed: 9_000
		});
	});

	it('does not record usage when a completion has no durable items', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'empty-context-usage-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'empty-context-usage',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-empty-usage',
			executionSecret
		});
		await registerCompletionAttempt(asUser, {
			runId,
			claimId: 'claim-empty-usage',
			executionSecret,
			attemptSeq: 1
		});

		await expect(
			asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
				runId,
				claimId: 'claim-empty-usage',
				attemptSeq: 1,
				streamId: 'stream-empty-usage',
				items: [],
				...emptyCompletionAssignments,
				usage: { contextTokens: 8_000, processedTokens: 9_000 },
				executionSecret
			})
		).resolves.toBeNull();
		const usage = await readThreadUsage(t, threadId);
		expect(usage?.contextTokens).toBeUndefined();
		expect(usage?.totalTokensProcessed).toBe(0);
	});

	it('rolls back the transcript when finalized usage is invalid', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'invalid-finalized-usage-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'invalid-finalized-usage',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-invalid-finalized-usage',
			executionSecret
		});

		await expect(
			finalizeTextCompletion(asUser, {
				runId,
				claimId: 'claim-invalid-finalized-usage',
				executionSecret,
				attemptSeq: 1,
				streamId: 'stream-invalid-finalized-usage',
				text: 'Must not persist',
				usage: { contextTokens: -1, processedTokens: 9_000 }
			})
		).rejects.toThrow('Invalid token count.');

		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(1);
		expect((await readThreadUsage(t, threadId))?.totalTokensProcessed).toBe(0);
	});

	it('fences usage writes to the active claim', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'context-run-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'context-run',
			executionSecret,
			'Continue the long task'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});

		await expect(
			asUser.mutation(api.agentRuntime.recordContextUsage, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				contextTokens: 8_000,
				processedTokens: 9_000
			})
		).resolves.toBe(true);

		expect(await readThreadUsage(t, threadId)).toMatchObject({
			contextTokens: 8_000,
			totalTokensProcessed: 9_000
		});

		await t.run(async (ctx) => {
			await patchRunExecution(ctx, runId, { claimExpiresAt: Date.now() - 1 });
		});
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-b',
			executionSecret
		});
		await expect(
			asUser.mutation(api.agentRuntime.recordContextUsage, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				contextTokens: 99_000,
				processedTokens: 99_000
			})
		).resolves.toBe(false);
		expect((await readThreadUsage(t, threadId))?.contextTokens).toBe(8_000);
		expect(
			await t.run(async (ctx) => (await ctx.db.get('threadRecords', threadId))?.contextSummary)
		).toBeFalsy();
	});

	it('does not double-count retried usage for the same model turn', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'idempotent-usage-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'idempotent-usage',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});
		const args = {
			runId,
			claimId: 'claim-a',
			executionSecret,
			contextTokens: 8_000,
			processedTokens: 9_000
		};
		await asUser.mutation(api.agentRuntime.recordContextUsage, args);
		await asUser.mutation(api.agentRuntime.recordContextUsage, args);
		expect(await readThreadUsage(t, threadId)).toMatchObject({
			contextTokens: 8_000,
			totalTokensProcessed: 9_000
		});
	});

	it('rejects invalid token accounting values', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'invalid-context-usage-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'invalid-context-usage',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});

		await expect(
			asUser.mutation(api.agentRuntime.recordContextUsage, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				contextTokens: -1,
				processedTokens: 10
			})
		).rejects.toThrow('Invalid token count.');
		expect((await readThreadUsage(t, threadId))?.totalTokensProcessed ?? 0).toBe(0);
	});

	it('getByThreadId returns the thread with usage counters merged in', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'merged-shape-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'merged-shape',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});
		await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-a',
			executionSecret,
			attemptSeq: 1,
			streamId: 'stream-merged-shape',
			text: 'Done',
			usage: { contextTokens: 8_000, processedTokens: 9_000 }
		});

		await expect(asUser.query(api.threads.getByThreadId, { threadId })).resolves.toMatchObject({
			contextTokens: 8_000,
			totalTokensProcessed: 9_000
		});
	});

	it('preserves opaque run model ids for the worker', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'context-opaque-model-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'context-opaque-model',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-opaque-model',
			executionSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', runId, {
				selectedModel: 'gateway-only-model',
				fastMode: true
			});
		});
		const context = await asUser.query(api.agentRuntime.getContext, {
			runId,
			executionSecret
		});
		expect(context.run.selectedModel).toBe('gateway-only-model');
		expect(context.run.fastMode).toBe(true);
	});

	it('getContext returns last provider-reported contextTokens', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'context-tokens-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'context-tokens',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-tokens',
			executionSecret
		});
		expect(
			(
				await asUser.query(api.agentRuntime.getContext, {
					runId,
					executionSecret
				})
			).contextTokens
		).toBeUndefined();
		await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-tokens',
			executionSecret,
			attemptSeq: 1,
			streamId: 'stream-context-tokens',
			text: 'Done',
			usage: { contextTokens: 12_345, processedTokens: 13_000 }
		});
		expect(
			await asUser.query(api.agentRuntime.getContext, {
				runId,
				executionSecret
			})
		).toMatchObject({ contextTokens: 12_345 });
	});

	it('records visible completion and handoff usage through a mid-run handoff', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'handoff-mid-run-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-mid-run',
			executionSecret,
			'Do the long task'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-handoff',
			executionSecret
		});
		const completionNumber = await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-handoff',
			executionSecret,
			attemptSeq: 1,
			streamId: 'stream-visible',
			text: 'Finished the first step',
			usage: { contextTokens: 4_000, processedTokens: 5_000 }
		});
		expect(completionNumber?.number).toBe(1);
		await appendFinishedToolPart(t, {
			threadId,
			runId,
			invocationId: 'tool-visible'
		});
		await registerCompletionAttempt(asUser, {
			runId,
			claimId: 'claim-handoff',
			executionSecret,
			attemptSeq: 2
		});

		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-handoff',
				executionSecret,
				summary: 'First step is done.',
				completionAttemptSeq: 2,
				beforePrompt: false,
				processedTokens: 2_000
			})
		).resolves.toBe(true);
		expect(await readThreadCutoff(t, threadId)).toEqual({
			contextSummary: 'First step is done.',
			contextSummaryThroughPartNumber: 2
		});
		const usage = await readThreadUsage(t, threadId);
		expect(usage?.contextTokens).toBeUndefined();
		expect(usage?.totalTokensProcessed).toBe(7_000);

		const state = await asUser.query(api.transcript.getState, { threadId });
		expect(state.historyFromNumber).toBe(3);
		expect(state.contextSummary).toBe('First step is done.');
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion', 'tool']);
	});

	it('clears only contextTokens on a new handoff and keeps processed totals', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'handoff-clear-tokens-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-clear-tokens',
			executionSecret,
			'Do the long task'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-clear',
			executionSecret
		});
		await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-clear',
			executionSecret,
			attemptSeq: 1,
			streamId: 'stream-clear',
			text: 'Finished the first step',
			usage: { contextTokens: 8_000, processedTokens: 9_000 }
		});
		await registerCompletionAttempt(asUser, {
			runId,
			claimId: 'claim-clear',
			executionSecret,
			attemptSeq: 2
		});
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-clear',
				executionSecret,
				summary: 'First step is done.',
				completionAttemptSeq: 2,
				beforePrompt: false,
				processedTokens: 2_000
			})
		).resolves.toBe(true);
		expect((await readThreadUsage(t, threadId))?.contextTokens).toBeUndefined();
		expect((await readThreadUsage(t, threadId))?.totalTokensProcessed).toBe(11_000);
	});

	it('keeps a stable cutoff when the same attempt retries after late parts', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'handoff-stable-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-stable',
			executionSecret,
			'Do the long task'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-stable',
			executionSecret
		});
		await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-stable',
			executionSecret,
			attemptSeq: 1,
			streamId: 'stream-stable',
			text: 'Finished the first step'
		});
		await registerCompletionAttempt(asUser, {
			runId,
			claimId: 'claim-stable',
			executionSecret,
			attemptSeq: 2
		});
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-stable',
				executionSecret,
				summary: 'First step is done.',
				completionAttemptSeq: 2,
				beforePrompt: false,
				processedTokens: 2_000
			})
		).resolves.toBe(true);
		await appendFinishedToolPart(t, {
			threadId,
			runId,
			invocationId: 'tool-late'
		});
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-stable',
				executionSecret,
				summary: 'First step is done.',
				completionAttemptSeq: 2,
				beforePrompt: false,
				processedTokens: 2_000
			})
		).resolves.toBe(true);
		expect(await readThreadCutoff(t, threadId)).toMatchObject({
			contextSummaryThroughPartNumber: 1
		});
		expect((await readThreadUsage(t, threadId))?.totalTokensProcessed).toBe(2_000);
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-stable',
				executionSecret,
				summary: 'A different document cannot replace the saved handoff.',
				completionAttemptSeq: 2,
				beforePrompt: false
			})
		).rejects.toThrow('Conflicting context handoff retry.');
	});

	it('rejects a handoff that would move the cutoff backwards', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'handoff-backwards-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-backwards',
			executionSecret,
			'Do the long task'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-backwards',
			executionSecret
		});
		await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-backwards',
			executionSecret,
			attemptSeq: 1,
			streamId: 'stream-backwards',
			text: 'Finished the first step'
		});
		await registerCompletionAttempt(asUser, {
			runId,
			claimId: 'claim-backwards',
			executionSecret,
			attemptSeq: 2
		});
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-backwards',
				executionSecret,
				summary: 'First step is done.',
				completionAttemptSeq: 2,
				beforePrompt: false
			})
		).resolves.toBe(true);
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-backwards',
				executionSecret,
				summary: 'Should not uncover work.',
				completionAttemptSeq: 2,
				beforePrompt: true
			})
		).rejects.toThrow('Invalid context handoff cutoff.');
		expect(await readThreadCutoff(t, threadId)).toMatchObject({
			contextSummary: 'First step is done.',
			contextSummaryThroughPartNumber: 1
		});
	});

	it('excludes the current run prompt when handing off before a new prompt', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const firstSecret = 'handoff-first-secret';
		const first = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-first',
			firstSecret,
			'Old prompt that should be covered'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: first.runId,
			claimId: 'claim-1',
			executionSecret: firstSecret
		});
		await finalizeTextCompletion(asUser, {
			runId: first.runId,
			claimId: 'claim-1',
			executionSecret: firstSecret,
			attemptSeq: 1,
			streamId: 'stream-old',
			text: 'Old work completed'
		});
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: first.runId,
			expectedStatus: 'running',
			expectedClaimId: 'claim-1',
			text: 'Old work completed',
			status: 'completed',
			executionSecret: firstSecret
		});

		const secondSecret = 'handoff-second-secret';
		const second = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-second',
			secondSecret,
			'New prompt'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: second.runId,
			claimId: 'claim-2',
			executionSecret: secondSecret
		});
		const promptParts = await asUser.query(api.transcript.getParts, {
			threadId,
			numbers: [0, 1, 2]
		});
		expect(promptParts.parts.map((part) => [part.number, part.kind, part.runId])).toEqual([
			[0, 'prompt', first.runId],
			[1, 'completion', first.runId],
			[2, 'prompt', second.runId]
		]);
		await registerCompletionAttempt(asUser, {
			runId: second.runId,
			claimId: 'claim-2',
			executionSecret: secondSecret,
			attemptSeq: 1
		});

		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId: second.runId,
				claimId: 'claim-2',
				executionSecret: secondSecret,
				summary: 'The old work is complete.',
				completionAttemptSeq: 1,
				beforePrompt: true
			})
		).resolves.toBe(true);
		expect(await readThreadCutoff(t, threadId)).toEqual({
			contextSummary: 'The old work is complete.',
			contextSummaryThroughPartNumber: 1
		});
		const state = await asUser.query(api.transcript.getStateForRun, {
			runId: second.runId,
			executionSecret: secondSecret
		});
		expect(state.historyFromNumber).toBe(2);
		const retained = await asUser.query(api.transcript.getParts, { threadId, numbers: [2] });
		expect(retained.parts[0]?.prompt?.text).toBe('New prompt');
	});

	it('records an empty prefix as -1 when the prompt is part 0', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'handoff-first-prompt-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-first-prompt',
			executionSecret,
			'Only prompt so far'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-first',
			executionSecret
		});
		await registerCompletionAttempt(asUser, {
			runId,
			claimId: 'claim-first',
			executionSecret,
			attemptSeq: 1
		});
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-first',
				executionSecret,
				summary: 'No prior work to cover.',
				completionAttemptSeq: 1,
				beforePrompt: true
			})
		).resolves.toBe(true);
		expect(await readThreadCutoff(t, threadId)).toEqual({
			contextSummary: 'No prior work to cover.',
			contextSummaryThroughPartNumber: -1
		});
		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			historyFromNumber: 0
		});
	});

	it('covers prior parts on a continuation that has no current-run parts', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const parentSecret = 'handoff-continue-parent-secret';
		const parent = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-continue-parent',
			parentSecret,
			'Parent prompt'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId: parent.runId,
			claimId: 'claim-parent',
			executionSecret: parentSecret
		});
		await finalizeTextCompletion(asUser, {
			runId: parent.runId,
			claimId: 'claim-parent',
			executionSecret: parentSecret,
			attemptSeq: 1,
			streamId: 'stream-parent',
			text: 'Parent work'
		});
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: parent.runId,
			expectedStatus: 'running',
			expectedClaimId: 'claim-parent',
			text: '',
			status: 'failed',
			lastError: 'boom',
			executionSecret: parentSecret
		});

		const continueSecret = 'handoff-continue-secret';
		const continued = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'handoff-continue',
			executionSecret: continueSecret,
			prompt: '',
			continuationOfRunId: parent.runId
		});
		await asUser.mutation(api.agentRuntime.start, {
			runId: continued.runId,
			claimId: 'claim-continue',
			executionSecret: continueSecret
		});
		await registerCompletionAttempt(asUser, {
			runId: continued.runId,
			claimId: 'claim-continue',
			executionSecret: continueSecret,
			attemptSeq: 1
		});
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId: continued.runId,
				claimId: 'claim-continue',
				executionSecret: continueSecret,
				summary: 'Parent work is done.',
				completionAttemptSeq: 1,
				beforePrompt: false
			})
		).resolves.toBe(true);
		expect(await readThreadCutoff(t, threadId)).toMatchObject({
			contextSummary: 'Parent work is done.',
			contextSummaryThroughPartNumber: 1
		});
		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			historyFromNumber: 2
		});
	});

	it('rejects stale claims and completion attempts without persisting a handoff', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'handoff-stale-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-stale',
			executionSecret,
			'Continue'
		);
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-a',
			executionSecret
		});
		await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-a',
			executionSecret,
			attemptSeq: 1,
			streamId: 'stream-stale',
			text: 'Step done'
		});
		await registerCompletionAttempt(asUser, {
			runId,
			claimId: 'claim-a',
			executionSecret,
			attemptSeq: 2
		});

		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				summary: 'Wrong attempt',
				completionAttemptSeq: 1,
				beforePrompt: false
			})
		).resolves.toBe(false);
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				summary: 'Wrong attempt',
				completionAttemptSeq: 3,
				beforePrompt: false
			})
		).resolves.toBe(false);
		expect(await readThreadCutoff(t, threadId)).toEqual({
			contextSummary: undefined,
			contextSummaryThroughPartNumber: undefined
		});

		await t.run(async (ctx) => {
			await patchRunExecution(ctx, runId, { claimExpiresAt: Date.now() - 1 });
		});
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-b',
			executionSecret
		});
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				runId,
				claimId: 'claim-a',
				executionSecret,
				summary: 'Stale claim',
				completionAttemptSeq: 0,
				beforePrompt: true
			})
		).resolves.toBe(false);
		expect((await readThreadCutoff(t, threadId)).contextSummary).toBeFalsy();
	});
});
