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

async function seedLegacyCutoffThread(
	t: ConvexTestInstance,
	args: {
		submissionId: string;
		throughPartNumber?: number;
		withParts: boolean;
	}
) {
	return await t.run(async (ctx) => {
		const threadId = await ctx.db.insert('threadRecords', {
			userId: 'user_alice',
			submissionId: args.submissionId,
			repositoryKey: 'alpha',
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			lastMessageAt: 1,
			contextSummary: 'Legacy summary'
		});
		const runId = await ctx.db.insert('runs', {
			threadId,
			userId: 'user_alice',
			submissionId: `${args.submissionId}-run`,
			status: 'completed',
			executionSecretHash: 'fixture',
			completionAttemptSeq: 0,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			startedAt: 1
		});
		await ctx.db.patch('threadRecords', threadId, {
			contextSummaryThroughRunId: runId,
			contextSummaryThroughPartNumber: args.throughPartNumber
		});
		if (args.withParts) {
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: 'user_alice',
				number: 0,
				sourceKey: 'prompt:legacy-cutoff',
				kind: 'prompt',
				runId,
				prompt: { text: 'Hello', imageUploads: [] }
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: 'user_alice',
				number: 1,
				sourceKey: 'completion:legacy-cutoff',
				kind: 'completion',
				runId,
				completion: {
					streamId: 'stream-legacy',
					items: [{ type: 'text', id: 't', text: 'done', startedAt: null, completedAt: null }]
				}
			});
		}
		return threadId;
	});
}

describe('context summary cutoff migration', () => {
	it('copies a run-id cutoff onto the last covered part number', async () => {
		const t = initConvexTest();
		const threadId = await seedLegacyCutoffThread(t, {
			submissionId: 'cutoff-copy',
			withParts: true
		});

		await t.mutation(internal.migrations.backfillContextSummaryThroughPartNumber, oneBatch);

		expect(await t.run(async (ctx) => await ctx.db.get('threadRecords', threadId))).toMatchObject({
			contextSummaryThroughPartNumber: 1
		});
	});

	it('records -1 when the cutoff run has no parts', async () => {
		const t = initConvexTest();
		const threadId = await seedLegacyCutoffThread(t, {
			submissionId: 'cutoff-empty',
			withParts: false
		});

		await t.mutation(internal.migrations.backfillContextSummaryThroughPartNumber, oneBatch);

		expect(await t.run(async (ctx) => await ctx.db.get('threadRecords', threadId))).toMatchObject({
			contextSummaryThroughPartNumber: -1
		});
	});

	it('leaves an existing part-number cutoff alone', async () => {
		const t = initConvexTest();
		const threadId = await seedLegacyCutoffThread(t, {
			submissionId: 'cutoff-keep',
			throughPartNumber: 0,
			withParts: true
		});

		await t.mutation(internal.migrations.backfillContextSummaryThroughPartNumber, oneBatch);

		expect(await t.run(async (ctx) => await ctx.db.get('threadRecords', threadId))).toMatchObject({
			contextSummaryThroughPartNumber: 0
		});
	});
});

describe('attachment retention migrations', () => {
	it('copies prompt attachments onto threadAttachmentRefs without duplicating', async () => {
		const t = initConvexTest();
		const ids = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('threadRecords', {
				userId: 'user_alice',
				submissionId: 'attach-refs',
				repositoryKey: 'alpha',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				lastMessageAt: 1
			});
			const runId = await ctx.db.insert('runs', {
				threadId,
				userId: 'user_alice',
				submissionId: 'attach-refs-run',
				status: 'completed',
				executionSecretHash: 'fixture',
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				startedAt: 1
			});
			const storageId = await ctx.storage.store(new Blob(['file']));
			const imageUploadId = await ctx.db.insert('imageUploads', {
				userId: 'user_alice',
				storageId,
				name: 'notes.txt',
				mediaType: 'text/plain',
				size: 4,
				attached: true
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: 'user_alice',
				number: 0,
				sourceKey: 'prompt:attach-refs',
				kind: 'prompt',
				runId,
				prompt: {
					text: 'Read this',
					imageUploads: [
						{
							imageUploadId,
							name: 'notes.txt',
							mediaType: 'text/plain',
							size: 4,
							storageId
						},
						{
							imageUploadId,
							name: 'notes.txt',
							mediaType: 'text/plain',
							size: 4,
							storageId
						}
					]
				}
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: 'user_alice',
				number: 1,
				sourceKey: 'prompt:attach-refs-again',
				kind: 'prompt',
				runId,
				prompt: {
					text: 'Again',
					imageUploads: [
						{
							imageUploadId,
							name: 'notes.txt',
							mediaType: 'text/plain',
							size: 4,
							storageId
						}
					]
				}
			});
			return { threadId, imageUploadId };
		});

		await t.mutation(internal.migrations.backfillThreadAttachmentRefs, oneBatch);
		await t.mutation(internal.migrations.backfillThreadAttachmentRefs, oneBatch);

		const refs = await t.run(async (ctx) =>
			ctx.db
				.query('threadAttachmentRefs')
				.withIndex('by_threadId_and_imageUploadId', (query) =>
					query.eq('threadId', ids.threadId).eq('imageUploadId', ids.imageUploadId)
				)
				.collect()
		);
		expect(refs).toHaveLength(1);
	});

	it('backfills updatedAt from stored activity instead of a new grace period', async () => {
		const t = initConvexTest();
		const threadId = await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('threadRecords', {
				userId: 'user_alice',
				submissionId: 'updated-at',
				repositoryKey: 'alpha',
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				lastMessageAt: 1
			});
			const runId = await ctx.db.insert('runs', {
				threadId,
				userId: 'user_alice',
				submissionId: 'updated-at-run',
				status: 'completed',
				executionSecretHash: 'fixture',
				completionAttemptSeq: 0,
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				startedAt: 2,
				completedAt: 3
			});
			await ctx.db.insert('threadTranscriptParts', {
				threadId,
				userId: 'user_alice',
				number: 0,
				sourceKey: 'prompt:updated-at',
				kind: 'prompt',
				runId,
				prompt: { text: 'Hello', imageUploads: [] }
			});
			return threadId;
		});

		const expected = await t.run(async (ctx) => {
			const thread = await ctx.db.get('threadRecords', threadId);
			if (!thread) throw new Error('Missing thread');
			const part = await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (query) => query.eq('threadId', threadId))
				.order('desc')
				.first();
			return Math.max(thread.lastMessageAt, thread._creationTime, part?._creationTime ?? 0, 3);
		});

		await t.mutation(internal.migrations.backfillThreadUpdatedAt, oneBatch);

		const migrated = await t.run(async (ctx) => await ctx.db.get('threadRecords', threadId));
		expect(migrated?.updatedAt).toBe(expected);
		expect(migrated?.updatedAt).not.toBe(Date.now() + 7 * 24 * 60 * 60 * 1_000);
	});

	it('stamps attached uploads only after associations are ready', async () => {
		const t = initConvexTest();
		const { attachedId, draftId } = await t.run(async (ctx) => {
			const attachedStorageId = await ctx.storage.store(new Blob(['a']));
			const draftStorageId = await ctx.storage.store(new Blob(['b']));
			const attachedId = await ctx.db.insert('imageUploads', {
				userId: 'user_alice',
				storageId: attachedStorageId,
				name: 'attached.txt',
				mediaType: 'text/plain',
				size: 1,
				attached: true
			});
			const draftId = await ctx.db.insert('imageUploads', {
				userId: 'user_alice',
				storageId: draftStorageId,
				name: 'draft.txt',
				mediaType: 'text/plain',
				size: 1,
				attached: false
			});
			return { attachedId, draftId };
		});

		await t.mutation(internal.migrations.markImageUploadThreadRefsMigrated, oneBatch);

		expect(await t.run(async (ctx) => await ctx.db.get('imageUploads', attachedId))).toMatchObject({
			threadRefsMigratedAt: expect.any(Number)
		});
		expect(
			(await t.run(async (ctx) => ctx.db.get('imageUploads', draftId)))?.threadRefsMigratedAt
		).toBeUndefined();
	});
});
