import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('agentRuntime.createRun', () => {
	it('rejects an empty prompt with no images', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await expect(
			asUser.mutation(api.agentRuntime.createRun, {
				submissionId: 'sub-empty',
				threadId,
				prompt: '   ',
				imageUploadIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard'
			})
		).rejects.toThrow('Message cannot be empty.');
	});

	it('creates a queued run and is idempotent for the same submission', async () => {
		const t = initConvexTest();
		const { asUser, threadId, subject } = await seedOwnedThread(t);
		const args = {
			submissionId: 'sub-1',
			threadId,
			prompt: 'Hello',
			imageUploadIds: [] as Id<'imageUploads'>[],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};

		const created = await asUser.mutation(api.agentRuntime.createRun, args);
		expect(created).toMatchObject({
			created: true,
			userId: subject
		});

		const again = await asUser.mutation(api.agentRuntime.createRun, args);
		expect(again).toEqual({
			created: false,
			runId: created.runId,
			promptMessageId: created.promptMessageId,
			userId: subject
		});

		const run = await t.run(async (ctx) => ctx.db.get(created.runId));
		expect(run).toMatchObject({
			status: 'queued',
			submissionId: 'sub-1',
			promptMessageId: created.promptMessageId
		});
	});

	it('rejects a second run while the thread has an active run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'sub-active',
			threadId,
			prompt: 'First',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});

		await expect(
			asUser.mutation(api.agentRuntime.createRun, {
				submissionId: 'sub-next',
				threadId,
				prompt: 'Second',
				imageUploadIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard'
			})
		).rejects.toThrow('Finish or cancel the active run before sending another message.');
	});

	it('allows a new run after the previous run reaches a final status', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const first = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'sub-done',
			threadId,
			prompt: 'First',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(first.runId, { status: 'completed', completedAt: Date.now() });
		});

		const second = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'sub-after',
			threadId,
			prompt: 'Second',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard'
		});
		expect(second.created).toBe(true);
		expect(second.runId).not.toBe(first.runId);
	});
});
