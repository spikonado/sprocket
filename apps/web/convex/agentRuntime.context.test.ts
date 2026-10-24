import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchRunExecution } from '@convex/lib/runExecution';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { appendTranscriptPart } from '@convex/lib/transcriptParts';
import type { ModelCallUsage } from '@convex/lib/validators';
import {
	createQueuedRun,
	emptyCompletionAssignments,
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	seedThreadRecord,
	type ConvexTestInstance
} from './test.setup';

async function readThreadUsage(t: ConvexTestInstance, threadId: Id<'threadRecords'>) {
	return await t.run(async (ctx) => {
		const contextRow = await ctx.db
			.query('threadUsage')
			.withIndex('by_threadId', (query) => query.eq('threadId', threadId))
			.unique();

		const totals = await ctx.db
			.query('threadTokenUsage')
			.withIndex('by_threadId_model', (query) => query.eq('threadId', threadId))
			.collect();

		const calls = await ctx.db.query('modelCallUsage').collect();
		const userBuckets = await ctx.db.query('userTokenUsage').collect();

		return { contextTokens: contextRow?.contextTokens, totals, calls, userBuckets };
	});
}

const callTokens = {
	inputTokens: 9_000,
	cacheReadTokens: 6_000,
	cacheWriteTokens: 1_000,
	outputTokens: 500,
	reasoningTokens: 200
};

const emptyTokens = {
	inputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	reasoningTokens: 0
};

function modelCall(overrides: Partial<ModelCallUsage> = {}): ModelCallUsage {
	return {
		provider: 'spikonado',
		model: 'gpt-5.6-sol',
		serviceTier: 'standard',
		cacheWriteTtl: '30m',
		longContext: false,
		...callTokens,
		...overrides
	};
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
		usage?: { contextTokens: number; call?: ModelCallUsage };
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
	afterEach(() => {
		vi.useRealTimers();
	});

	it('records usage atomically with a durable completion', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-08-01T23:59:30.000Z'));

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
			usage: { contextTokens: 8_000, call: modelCall() }
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
			usage: { contextTokens: 8_000, call: modelCall() },
			executionSecret
		});

		vi.setSystemTime(new Date('2026-08-02T00:00:30.000Z'));
		await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-finalized-usage',
			executionSecret,
			attemptSeq: 2,
			streamId: 'stream-finalized-usage-2',
			text: 'Done again',
			usage: { contextTokens: 300_000, call: modelCall({ longContext: true }) }
		});

		const firstCall = { calls: 1, standard: callTokens, longContext: emptyTokens };
		const secondCall = { calls: 1, standard: emptyTokens, longContext: callTokens };
		const usage = await readThreadUsage(t, threadId);

		expect(usage.contextTokens).toBe(300_000);
		expect(usage.calls.map((call) => call.eventId)).toEqual([
			'turn:claim-finalized-usage:1',
			'turn:claim-finalized-usage:2'
		]);
		expect(usage.totals).toEqual([
			expect.objectContaining({
				model: 'gpt-5.6-sol',
				calls: 2,
				standard: callTokens,
				longContext: callTokens
			})
		]);
		expect(usage.userBuckets).toHaveLength(4);
		expect(usage.userBuckets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					granularity: 'hour',
					bucketStart: Date.parse('2026-08-01T23:00:00.000Z'),
					...firstCall
				}),
				expect.objectContaining({
					granularity: 'day',
					bucketStart: Date.parse('2026-08-01T00:00:00.000Z'),
					...firstCall
				}),
				expect.objectContaining({
					granularity: 'hour',
					bucketStart: Date.parse('2026-08-02T00:00:00.000Z'),
					...secondCall
				}),
				expect.objectContaining({
					granularity: 'day',
					bucketStart: Date.parse('2026-08-02T00:00:00.000Z'),
					...secondCall
				})
			])
		);

		expect(await asUser.query(api.aiUsage.getRunUsage, { runId })).toEqual([
			expect.objectContaining({ calls: 2, standard: callTokens, longContext: callTokens })
		]);

		const days = await asUser.query(api.aiUsage.getMyUsageBuckets, {
			granularity: 'day',
			from: Date.parse('2026-08-02T00:00:00.000Z'),
			to: Date.parse('2026-08-03T00:00:00.000Z')
		});

		expect(days).toEqual([
			expect.objectContaining({
				bucketStart: Date.parse('2026-08-02T00:00:00.000Z'),
				...secondCall
			})
		]);
	});

	it('reports subagent totals with the parent thread usage', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const subagentId = await seedThreadRecord(t, subject, 'alpha');

		const totals = {
			provider: 'spikonado' as const,
			model: 'gpt-5.6-sol',
			serviceTier: 'standard' as const,
			cacheWriteTtl: '30m',
			calls: 1,
			standard: callTokens,
			longContext: emptyTokens
		};

		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', subagentId, {
				parentThreadId: threadId,
				title: 'Research'
			});
			await ctx.db.insert('threadTokenUsage', { threadId: subagentId, userId: subject, ...totals });
		});

		expect(await asUser.query(api.aiUsage.getThreadUsage, { threadId })).toEqual({
			totals: [],
			subagents: [{ threadId: subagentId, title: 'Research', totals: [totals] }]
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
				usage: { contextTokens: 8_000, call: modelCall() },
				executionSecret
			})
		).resolves.toBeNull();
		const usage = await readThreadUsage(t, threadId);
		expect(usage.contextTokens).toBeUndefined();
		expect(usage.calls).toEqual([]);
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
				usage: { contextTokens: 8_000, call: modelCall({ cacheReadTokens: 10_000 }) }
			})
		).rejects.toThrow('Invalid token count.');

		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(1);
		expect((await readThreadUsage(t, threadId)).totals).toEqual([]);
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
			usage: { contextTokens: 12_345 }
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
			usage: { contextTokens: 4_000, call: modelCall() }
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
				handoffCalls: [
					modelCall(),
					modelCall({ provider: 'chatgpt' }),
					modelCall({ cacheWriteTtl: '1h' })
				]
			})
		).resolves.toBe(true);
		expect(await readThreadCutoff(t, threadId)).toEqual({
			contextSummary: 'First step is done.',
			contextSummaryThroughPartNumber: 2
		});
		const usage = await readThreadUsage(t, threadId);
		expect(usage.contextTokens).toBeUndefined();
		expect(usage.calls.map((call) => [call.eventId, call.provider])).toEqual([
			['turn:claim-handoff:1', 'spikonado'],
			['handoff:claim-handoff:2:0', 'spikonado'],
			['handoff:claim-handoff:2:1', 'chatgpt'],
			['handoff:claim-handoff:2:2', 'spikonado']
		]);
		expect(usage.totals.map((total) => [total.provider, total.cacheWriteTtl, total.calls])).toEqual(
			[
				['chatgpt', '30m', 1],
				['spikonado', '1h', 1],
				['spikonado', '30m', 2]
			]
		);

		const state = await asUser.query(api.transcript.getState, { threadId });
		expect(state.historyFromNumber).toBe(3);
		expect(state.contextSummary).toBe('First step is done.');
		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1, 2] });
		expect(parts.parts.map((part) => part.kind)).toEqual(['prompt', 'completion', 'tool']);
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
				handoffCalls: [modelCall()]
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
				handoffCalls: [modelCall()]
			})
		).resolves.toBe(true);
		expect(await readThreadCutoff(t, threadId)).toMatchObject({
			contextSummaryThroughPartNumber: 1
		});
		expect((await readThreadUsage(t, threadId)).totals).toEqual([
			expect.objectContaining({ calls: 1 })
		]);
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

	it('begins a deferred run with its context before its prompt', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'begin-secret';
		const claim = { claimId: 'claim-begin', executionSecret };

		const { runId, promptPart } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'begin',
			executionSecret,
			prompt: 'Do the long task',
			deferPrompt: true
		});

		expect(promptPart).toBeUndefined();
		await expect(
			asUser.query(api.agentRuntime.getContext, { runId, executionSecret })
		).resolves.toMatchObject({
			pendingPrompt: { text: 'Do the long task', imageUploads: [] }
		});

		await asUser.mutation(api.agentRuntime.start, { runId, ...claim });
		const environment = { kind: 'environment' as const, text: '# Environment' };

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				asUser.mutation(api.agentRuntime.beginRun, {
					runId,
					...claim,
					workspaceContext: [environment]
				})
			).resolves.toBe(true);
		}

		await expect(
			asUser.query(api.agentRuntime.getContext, { runId, executionSecret })
		).resolves.not.toHaveProperty('pendingPrompt');

		await finalizeTextCompletion(asUser, {
			runId,
			...claim,
			attemptSeq: 1,
			streamId: 'stream-begin',
			text: 'Finished the first step'
		});
		await registerCompletionAttempt(asUser, { runId, ...claim, attemptSeq: 2 });
		await asUser.mutation(api.agentRuntime.saveContextHandoff, {
			runId,
			...claim,
			summary: 'First step is done.',
			completionAttemptSeq: 2,
			workspaceContext: [environment]
		});

		const parts = await t.run(async (ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (query) => query.eq('threadId', threadId))
				.collect()
		);

		expect(parts.map((part) => [part.kind, part.prompt?.hidden ?? part.prompt?.text])).toEqual([
			['prompt', 'environment'],
			['prompt', 'Do the long task'],
			['completion', undefined],
			['prompt', 'environment']
		]);
		expect(await readThreadCutoff(t, threadId)).toMatchObject({
			contextSummaryThroughPartNumber: 2
		});
	});

	it('begins a run with a handoff that covers the earlier runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const first = await createQueuedRun(t, asUser, threadId, 'begin-first', 'first-secret');
		const firstClaim = { claimId: 'claim-1', executionSecret: 'first-secret' };

		await asUser.mutation(api.agentRuntime.start, { runId: first.runId, ...firstClaim });
		await finalizeTextCompletion(asUser, {
			runId: first.runId,
			...firstClaim,
			attemptSeq: 1,
			streamId: 'stream-first',
			text: 'Old work completed',
			usage: { contextTokens: 90_000 }
		});
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: first.runId,
			expectedStatus: 'running',
			expectedClaimId: 'claim-1',
			text: 'Old work completed',
			status: 'completed',
			executionSecret: 'first-secret'
		});

		const claim = { claimId: 'claim-2', executionSecret: 'second-secret' };

		const second = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'begin-second',
			executionSecret: claim.executionSecret,
			prompt: 'New prompt',
			deferPrompt: true
		});

		await asUser.mutation(api.agentRuntime.start, { runId: second.runId, ...claim });
		await registerCompletionAttempt(asUser, { runId: second.runId, ...claim, attemptSeq: 1 });

		await expect(
			asUser.mutation(api.agentRuntime.beginRun, {
				runId: second.runId,
				...claim,
				workspaceContext: [{ kind: 'environment', text: '# Environment' }],
				handoff: {
					summary: 'The old work is complete.',
					completionAttemptSeq: 1,
					handoffCalls: [modelCall()]
				}
			})
		).resolves.toBe(true);

		expect(await readThreadCutoff(t, threadId)).toEqual({
			contextSummary: 'The old work is complete.',
			contextSummaryThroughPartNumber: 1
		});
		expect((await readThreadUsage(t, threadId)).contextTokens).toBeUndefined();

		const retained = await asUser.query(api.transcript.getParts, { threadId, numbers: [2, 3] });

		expect(retained.parts.map((part) => part.prompt?.hidden ?? part.prompt?.text)).toEqual([
			'environment',
			'New prompt'
		]);
	});

	it('settles a new thread whose first run fails before it begins', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'never-began-secret';

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'never-began',
			executionSecret,
			prompt: 'Lost before begin',
			deferPrompt: true
		});

		await asUser.mutation(api.agentRuntime.finalizeFailedStart, {
			submissionId: 'never-began',
			threadId,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			fastMode: false,
			executionSecret,
			text: '',
			lastError: 'startup failed'
		});

		const { run, thread } = await t.run(async (ctx) => ({
			run: await ctx.db.get('runs', runId),
			thread: await ctx.db.get('threadRecords', threadId)
		}));

		expect(run).toMatchObject({ status: 'failed', pendingPrompt: { text: 'Lost before begin' } });
		expect(thread?.archivedAt).toBeTypeOf('number');

		const continuation = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'continue-never-began',
			executionSecret,
			prompt: '',
			continuationOfRunId: runId,
			deferPrompt: true
		});

		await expect(
			asUser.query(api.agentRuntime.getContext, { runId: continuation.runId, executionSecret })
		).resolves.toMatchObject({ pendingPrompt: { text: 'Lost before begin' } });
	});

	it('does not begin a run the user stopped', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'stopped-secret';
		const claim = { claimId: 'claim-stopped', executionSecret };

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'stopped',
			executionSecret,
			prompt: 'Stop me',
			deferPrompt: true
		});

		await asUser.mutation(api.agentRuntime.start, { runId, ...claim });
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId });

		await expect(
			asUser.mutation(api.agentRuntime.beginRun, { runId, ...claim, workspaceContext: [] })
		).resolves.toBe(false);
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

	it('records an omitted reasoning replay without replacing the conversation', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'omit-reasoning-secret';

		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'omit-reasoning',
			executionSecret,
			'Continue on the new provider'
		);

		await asUser.mutation(api.agentRuntime.start, {
			runId,
			claimId: 'claim-omit',
			executionSecret
		});

		const completion = await finalizeTextCompletion(asUser, {
			runId,
			claimId: 'claim-omit',
			executionSecret,
			attemptSeq: 1,
			streamId: 'stream-omit',
			text: 'Visible answer',
			usage: { contextTokens: 10 }
		});

		expect(completion?.number).toBe(1);
		await expect(
			asUser.mutation(api.agentRuntime.omitReasoningReplay, {
				runId,
				claimId: 'wrong-claim',
				executionSecret,
				beforePrompt: false
			})
		).resolves.toBe(false);
		await expect(
			asUser.mutation(api.agentRuntime.omitReasoningReplay, {
				runId,
				claimId: 'claim-omit',
				executionSecret,
				beforePrompt: false
			})
		).resolves.toBe(true);
		await expect(
			asUser.mutation(api.agentRuntime.omitReasoningReplay, {
				runId,
				claimId: 'claim-omit',
				executionSecret,
				beforePrompt: true
			})
		).resolves.toBe(true);

		const thread = await t.run(async (ctx) => ctx.db.get('threadRecords', threadId));

		expect(thread?.contextSummary).toBeUndefined();
		expect(thread?.reasoningStrippedThroughPartNumber).toBe(1);
		expect(await asUser.query(api.transcript.getState, { threadId })).toMatchObject({
			historyFromNumber: 0,
			reasoningStrippedThroughPartNumber: 1
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
