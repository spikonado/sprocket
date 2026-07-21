import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { initConvexTest, seedOwnedThread } from './test.setup';

async function createQueuedRun(
	asUser: ReturnType<ReturnType<typeof initConvexTest>['withIdentity']>,
	threadId: Id<'threadRecords'>,
	submissionId: string,
	prompt = `Prompt ${submissionId}`
) {
	return await asUser.mutation(api.agentRuntime.createRun, {
		submissionId,
		threadId,
		prompt,
		imageUploadIds: [],
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard'
	});
}

async function completeRun(
	t: ReturnType<typeof initConvexTest>,
	asUser: ReturnType<ReturnType<typeof initConvexTest>['withIdentity']>,
	args: {
		runId: Id<'runs'>;
		status: 'completed' | 'failed' | 'cancelled';
		responseText?: string;
		startedAt?: number;
	}
) {
	await asUser.mutation(api.agentRuntime.start, {
		claimId: `claim-${args.runId}`,
		runId: args.runId
	});
	await asUser.mutation(api.agentRuntime.beginAssistantMessage, { runId: args.runId });
	await asUser.mutation(api.agentRuntime.finalizeRun, {
		runId: args.runId,
		text: args.responseText ?? `Response for ${args.runId}`,
		status: args.status,
		...(args.status === 'failed' ? { lastError: 'failed' } : {})
	});
	if (args.startedAt !== undefined) {
		await t.run(async (ctx) => {
			await ctx.db.patch(args.runId, { startedAt: args.startedAt });
		});
	}
}

describe('messages transcript queries', () => {
	it('requires authentication and ownership', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_owner');
		await createQueuedRun(asUser, threadId, 'sub-auth');
		const stranger = t.withIdentity({ subject: 'user_stranger' });
		const legacyArgs = { threadId, paginationOpts: { cursor: null, numItems: 40 } };

		for (const client of [t, stranger]) {
			const expected = client === t ? 'Authentication required.' : 'Thread not found.';
			await expect(client.query(api.messages.listHistoryForThread, { threadId })).rejects.toThrow(
				expected
			);
			await expect(client.query(api.messages.listLiveForThread, { threadId })).rejects.toThrow(
				expected
			);
			await expect(client.query(api.messages.listForThread, legacyArgs)).rejects.toThrow(expected);
		}
	});

	it('keeps active runs in live and excludes them from history', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const active = await createQueuedRun(asUser, threadId, 'sub-active', 'Live prompt');

		const history = await asUser.query(api.messages.listHistoryForThread, { threadId });
		const live = await asUser.query(api.messages.listLiveForThread, { threadId });

		expect(history.messages).toEqual([]);
		expect(live.messages).toHaveLength(1);
		expect(live.messages[0]).toMatchObject({
			_id: active.promptMessageId,
			type: 'prompt',
			text: 'Live prompt',
			runStatus: 'queued'
		});
	});

	it('streams live responses then moves terminal runs into history', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(asUser, threadId, 'sub-stream', 'Stream me');

		await asUser.mutation(api.agentRuntime.start, { claimId: 'claim-stream', runId });
		await asUser.mutation(api.agentRuntime.beginAssistantMessage, { runId });

		const beforeStream = await asUser.query(api.messages.listLiveForThread, { threadId });
		expect(beforeStream.messages.map((message) => message.type)).toEqual(['prompt', 'response']);
		expect(beforeStream.messages[1]?.text).toBe('');

		const responseMessageId = await t.run(async (ctx) => {
			const run = await ctx.db.get(runId);
			if (!run?.responseMessageId) {
				throw new Error('Expected response message');
			}
			await ctx.db.patch(run.responseMessageId, {
				text: 'partial answer',
				parts: [{ type: 'text', id: 't1', text: 'partial answer', turnId: 'turn-1' }],
				streamSequence: 1,
				streamAttemptId: 'stream-1'
			});
			return run.responseMessageId;
		});

		const streaming = await asUser.query(api.messages.listLiveForThread, { threadId });
		expect(streaming.messages[1]).toMatchObject({
			_id: responseMessageId,
			text: 'partial answer',
			runStatus: 'running'
		});
		expect((await asUser.query(api.messages.listHistoryForThread, { threadId })).messages).toEqual(
			[]
		);

		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId,
			text: 'final answer',
			status: 'completed'
		});

		expect((await asUser.query(api.messages.listLiveForThread, { threadId })).messages).toEqual([]);
		const historyAfter = await asUser.query(api.messages.listHistoryForThread, { threadId });
		// finalizeRun prefers already-streamed assistant text when parts exist.
		expect(historyAfter.messages.map((message) => [message.type, message.text])).toEqual([
			['prompt', 'Stream me'],
			['response', 'partial answer']
		]);
		expect(historyAfter.messages.every((message) => message.runStatus === 'completed')).toBe(true);
	});

	it('moves failed and cancelled runs from live into history', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const failed = await createQueuedRun(asUser, threadId, 'sub-fail', 'Fail prompt');
		await completeRun(t, asUser, { runId: failed.runId, status: 'failed', responseText: 'boom' });

		const cancelled = await createQueuedRun(asUser, threadId, 'sub-cancel', 'Cancel prompt');
		await completeRun(t, asUser, {
			runId: cancelled.runId,
			status: 'cancelled',
			responseText: 'stopped'
		});

		expect((await asUser.query(api.messages.listLiveForThread, { threadId })).messages).toEqual([]);
		const history = await asUser.query(api.messages.listHistoryForThread, { threadId });
		expect(history.messages.map((message) => [message.text, message.runStatus])).toEqual([
			['Fail prompt', 'failed'],
			['boom', 'failed'],
			['Cancel prompt', 'cancelled'],
			['stopped', 'cancelled']
		]);
	});

	it('orders history chronologically across terminal statuses and bounds to newest 20 runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const statuses = ['completed', 'failed', 'cancelled'] as const;

		for (let index = 0; index < 25; index += 1) {
			const created = await createQueuedRun(asUser, threadId, `sub-bound-${index}`, `P${index}`);
			await completeRun(t, asUser, {
				runId: created.runId,
				status: statuses[index % statuses.length]!,
				responseText: `R${index}`,
				startedAt: 1_000 + index
			});
		}

		const history = await asUser.query(api.messages.listHistoryForThread, { threadId });
		const promptTexts = history.messages
			.filter((message) => message.type === 'prompt')
			.map((message) => message.text);
		expect(promptTexts).toEqual(Array.from({ length: 20 }, (_, index) => `P${index + 5}`));
		expect(history.messages).toHaveLength(40);
		expect(history.messages.map((message) => message.text)).toEqual(
			promptTexts.flatMap((prompt, index) => [prompt, `R${index + 5}`])
		);
	});

	it('hydrates authorized attachments and skips unauthorized or missing uploads', async () => {
		const t = initConvexTest();
		const { asUser, threadId, subject } = await seedOwnedThread(t);
		const created = await createQueuedRun(asUser, threadId, 'sub-attach', 'With images');

		const { validUploadId, orphanUploadId, missingUploadId } = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['image-bytes'], { type: 'image/png' }));
			const validUploadId = await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId,
				name: 'shot.png',
				mediaType: 'image/png',
				size: 11,
				messageIds: [created.promptMessageId],
				attached: true
			});
			const orphanStorageId = await ctx.storage.store(new Blob(['other'], { type: 'image/jpeg' }));
			const orphanUploadId = await ctx.db.insert('imageUploads', {
				userId: 'someone-else',
				storageId: orphanStorageId,
				name: 'other.jpg',
				mediaType: 'image/jpeg',
				size: 5,
				messageIds: [created.promptMessageId],
				attached: true
			});
			const missingStorageId = await ctx.storage.store(new Blob(['gone'], { type: 'image/gif' }));
			const missingUploadId = await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId: missingStorageId,
				name: 'gone.gif',
				mediaType: 'image/gif',
				size: 4,
				messageIds: [created.promptMessageId],
				attached: true
			});
			await ctx.db.patch(created.promptMessageId, {
				imageUploadIds: [validUploadId, orphanUploadId, missingUploadId]
			});
			await ctx.db.delete(missingUploadId);
			return { validUploadId, orphanUploadId, missingUploadId };
		});

		await completeRun(t, asUser, {
			runId: created.runId,
			status: 'completed',
			responseText: 'done'
		});

		await t.run(async (ctx) => {
			const run = await ctx.db.get(created.runId);
			if (run?.responseMessageId) {
				await ctx.db.delete(run.responseMessageId);
			}
		});

		const history = await asUser.query(api.messages.listHistoryForThread, { threadId });
		expect(history.messages).toHaveLength(1);
		expect(history.messages[0]?.attachments).toEqual([
			expect.objectContaining({
				imageUploadId: validUploadId,
				name: 'shot.png',
				mediaType: 'image/png',
				size: 11,
				url: expect.any(String)
			})
		]);
		expect(
			history.messages[0]?.attachments.some(
				(attachment) =>
					attachment.imageUploadId === orphanUploadId ||
					attachment.imageUploadId === missingUploadId
			)
		).toBe(false);
	});

	it('returns at most 40 indexed messages from legacy listForThread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		for (let index = 0; index < 25; index += 1) {
			const created = await createQueuedRun(asUser, threadId, `sub-legacy-${index}`, `LP${index}`);
			await completeRun(t, asUser, {
				runId: created.runId,
				status: 'completed',
				responseText: `LR${index}`,
				startedAt: 2_000 + index
			});
		}

		const page = await asUser.query(api.messages.listForThread, {
			threadId,
			paginationOpts: { cursor: null, numItems: 100 }
		});
		expect(page.page).toHaveLength(40);
		expect(page.page[0]?.text).toBe('LP5');
		expect(page.page.at(-1)?.text).toBe('LR24');
		expect(page.isDone).toBe(false);
		expect(page.continueCursor).toEqual(expect.any(String));
	});
});
