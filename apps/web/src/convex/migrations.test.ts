import { describe, expect, it } from 'vitest';
import { internal } from '@convex/_generated/api';
import { initConvexTest, type ConvexTestInstance } from './test.setup';

const oneBatch = {
	cursor: null,
	dryRun: false,
	oneBatchOnly: true
} as const;

describe('thread status migration', () => {
	it('backfills status from the latest run', async () => {
		const t = initConvexTest();
		const threadId = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('threadRecords', {
				userId: 'user_alice',
				submissionId: 'thread-submission',
				repositoryKey: 'alpha',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				lastMessageAt: 2
			});
			for (const [submissionId, status, startedAt] of [
				['older-run', 'completed', 1],
				['latest-run', 'running', 2]
			] as const) {
				await ctx.db.insert('runs', {
					threadId,
					userId: 'user_alice',
					submissionId,
					status,
					executionSecretHash: 'fixture',
					completionAttemptSeq: 0,
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					serviceTier: 'standard',
					startedAt
				});
			}
			return threadId;
		});

		await t.mutation(internal.migrations.backfillThreadStatus, oneBatch);

		expect(await t.run(async (ctx) => await ctx.db.get('threadRecords', threadId))).toMatchObject({
			status: 'running'
		});
	});

	it('deletes runless threads and their usage rows', async () => {
		const t = initConvexTest();
		const { threadId, usageId } = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('threadRecords', {
				userId: 'user_alice',
				submissionId: 'runless-submission',
				repositoryKey: 'alpha',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				lastMessageAt: 1
			});
			const usageId = await ctx.db.insert('threadUsage', {
				threadId,
				userId: 'user_alice',
				totalTokensProcessed: 0
			});
			return { threadId, usageId };
		});

		await t.mutation(internal.migrations.backfillThreadStatus, oneBatch);

		const migrated = await t.run(async (ctx) => ({
			thread: await ctx.db.get('threadRecords', threadId),
			usage: await ctx.db.get('threadUsage', usageId)
		}));
		expect(migrated.thread).toBeNull();
		expect(migrated.usage).toBeNull();
	});
});

async function seedTranscriptTimingParts(t: ConvexTestInstance) {
	return await t.run(async (ctx) => {
		const threadId = await ctx.db.insert('threadRecords', {
			userId: 'user_alice',
			submissionId: 'timing-thread',
			repositoryKey: 'alpha',
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			lastMessageAt: 1
		});
		const runId = await ctx.db.insert('runs', {
			threadId,
			userId: 'user_alice',
			submissionId: 'timing-run',
			status: 'completed',
			executionSecretHash: 'fixture',
			completionAttemptSeq: 0,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			startedAt: 1
		});
		const completionId = await ctx.db.insert('threadTranscriptParts', {
			threadId,
			userId: 'user_alice',
			number: 0,
			sourceKey: 'completion:legacy',
			kind: 'completion',
			runId,
			completion: {
				streamId: 'stream-1',
				items: [
					{ type: 'text', id: 'missing', text: 'untimed', turnId: 'stream-1' },
					{ type: 'text', id: 'zero', text: 'zero', startedAt: 0, completedAt: 0 },
					{ type: 'text', id: 'nulls', text: 'already null', startedAt: null, completedAt: null },
					{
						type: 'text',
						id: 'known',
						text: 'known',
						startedAt: 1_000,
						completedAt: 2_000,
						providerMetadata: { model: 'gpt' }
					},
					{ type: 'reasoning', id: 'partial', text: 'think', completedAt: 5 },
					{
						type: 'tool-call',
						partId: 'p1',
						callId: 'c1',
						name: 'exec_command',
						input: { cmd: 'ls' },
						turnId: 'stream-1',
						startedAt: 3
					}
				]
			}
		});
		const timedId = await ctx.db.insert('threadTranscriptParts', {
			threadId,
			userId: 'user_alice',
			number: 1,
			sourceKey: 'completion:timed',
			kind: 'completion',
			runId,
			completion: {
				streamId: 'stream-2',
				items: [{ type: 'text', id: 'timed', text: 'done', startedAt: 10, completedAt: 20 }]
			}
		});
		const promptId = await ctx.db.insert('threadTranscriptParts', {
			threadId,
			userId: 'user_alice',
			number: 2,
			sourceKey: 'prompt:legacy',
			kind: 'prompt',
			runId,
			prompt: { text: 'Hello', imageUploads: [] }
		});
		const toolId = await ctx.db.insert('threadTranscriptParts', {
			threadId,
			userId: 'user_alice',
			number: 3,
			sourceKey: 'tool:legacy',
			kind: 'tool',
			runId,
			tool: {
				toolInvocationId: 'inv-1',
				callId: 'c1',
				name: 'exec_command',
				status: 'started'
			}
		});
		return { completionId, timedId, promptId, toolId };
	});
}

async function loadTranscriptTimingParts(
	t: ConvexTestInstance,
	ids: Awaited<ReturnType<typeof seedTranscriptTimingParts>>
) {
	return await t.run(async (ctx) => ({
		completion: await ctx.db.get('threadTranscriptParts', ids.completionId),
		timed: await ctx.db.get('threadTranscriptParts', ids.timedId),
		prompt: await ctx.db.get('threadTranscriptParts', ids.promptId),
		tool: await ctx.db.get('threadTranscriptParts', ids.toolId)
	}));
}

const normalizedLegacyItems = [
	{
		type: 'text',
		id: 'missing',
		text: 'untimed',
		turnId: 'stream-1',
		startedAt: null,
		completedAt: null
	},
	{ type: 'text', id: 'zero', text: 'zero', startedAt: 0, completedAt: 0 },
	{ type: 'text', id: 'nulls', text: 'already null', startedAt: null, completedAt: null },
	{
		type: 'text',
		id: 'known',
		text: 'known',
		startedAt: 1_000,
		completedAt: 2_000,
		providerMetadata: { model: 'gpt' }
	},
	{ type: 'reasoning', id: 'partial', text: 'think', startedAt: null, completedAt: 5 },
	{
		type: 'tool-call',
		partId: 'p1',
		callId: 'c1',
		name: 'exec_command',
		input: { cmd: 'ls' },
		turnId: 'stream-1',
		startedAt: 3,
		completedAt: null
	}
];

describe('transcript timing migration', () => {
	it('nulls missing completion timestamps and leaves other fields alone', async () => {
		const t = initConvexTest();
		const ids = await seedTranscriptTimingParts(t);
		const before = await loadTranscriptTimingParts(t, ids);

		await t.mutation(internal.migrations.backfillTranscriptTiming, oneBatch);

		const after = await loadTranscriptTimingParts(t, ids);
		expect(after.completion?.completion).toEqual({
			streamId: 'stream-1',
			items: normalizedLegacyItems
		});
		expect(after.completion).toMatchObject({
			kind: 'completion',
			number: 0,
			sourceKey: 'completion:legacy',
			userId: 'user_alice'
		});
		expect(after.timed).toEqual(before.timed);
		expect(after.prompt).toEqual(before.prompt);
		expect(after.tool).toEqual(before.tool);
	});

	it('does not change documents on a second run', async () => {
		const t = initConvexTest();
		const ids = await seedTranscriptTimingParts(t);

		await t.mutation(internal.migrations.backfillTranscriptTiming, oneBatch);
		const first = await loadTranscriptTimingParts(t, ids);
		await t.mutation(internal.migrations.backfillTranscriptTiming, oneBatch);

		expect(await loadTranscriptTimingParts(t, ids)).toEqual(first);
	});
});
