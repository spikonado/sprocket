import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

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
				serviceTier: 'standard',
				executionSecret: 'empty-prompt-secret'
			})
		).rejects.toThrow('Message cannot be empty.');
	});

	it('creates a queued run and is idempotent for the same submission', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const args = {
			submissionId: 'sub-1',
			threadId,
			prompt: 'Hello',
			imageUploadIds: [] as Id<'imageUploads'>[],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const,
			executionSecret: 'idempotent-secret'
		};

		const created = await asUser.mutation(api.agentRuntime.createRun, args);
		expect(created).toMatchObject({ created: true });

		const again = await asUser.mutation(api.agentRuntime.createRun, args);
		expect(again).toEqual({
			created: false,
			runId: created.runId,
			promptMessageId: created.promptMessageId
		});

		const run = await t.run(async (ctx) => ctx.db.get(created.runId));
		expect(run).toMatchObject({
			status: 'queued',
			submissionId: 'sub-1',
			promptMessageId: created.promptMessageId
		});
	});

	it('lets the local executor continue without a browser identity using its run capability', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'executor-secret';
		const created = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'sub-capability',
			threadId,
			prompt: 'Keep going after the tab closes',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			executionSecret
		});

		await expect(
			t.mutation(api.agentRuntime.start, {
				runId: created.runId,
				claimId: 'claim-wrong',
				executionSecret: 'wrong-secret'
			})
		).rejects.toThrow('Run not found.');

		await expect(
			t.mutation(api.agentRuntime.start, {
				runId: created.runId,
				claimId: 'claim-local',
				executionSecret
			})
		).resolves.toMatchObject({ claimed: true });
		expect(
			await t.run(async (ctx) => (await ctx.db.get(created.runId))?.executionSecretHash)
		).not.toBe(executionSecret);

		const expiredAt = await t.run(async (ctx) => {
			const claimExpiresAt = Date.now() - 1;
			await ctx.db.patch(created.runId, { claimExpiresAt });
			return claimExpiresAt;
		});
		await expect(
			t.mutation(api.agentRuntime.renewClaim, {
				runId: created.runId,
				claimId: 'claim-local',
				executionSecret
			})
		).resolves.toMatchObject({ renewed: false });
		expect(await t.run(async (ctx) => (await ctx.db.get(created.runId))?.claimExpiresAt)).toBe(
			expiredAt
		);
	});

	it('rebinds a queued submission when its original local executor was lost', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const args = {
			submissionId: 'sub-rebind',
			threadId,
			prompt: 'Recover this launch',
			imageUploadIds: [] as Id<'imageUploads'>[],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		const created = await asUser.mutation(api.agentRuntime.createRun, {
			...args,
			executionSecret: 'lost-secret'
		});

		await expect(
			asUser.mutation(api.agentRuntime.createRun, {
				...args,
				executionSecret: 'replacement-secret'
			})
		).resolves.toMatchObject({ created: false, runId: created.runId });
		await expect(
			t.mutation(api.agentRuntime.start, {
				runId: created.runId,
				claimId: 'replacement-claim',
				executionSecret: 'replacement-secret'
			})
		).resolves.toMatchObject({ claimed: true });
	});

	it('reconciles a queued run by capability after browser authentication is gone', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'cleanup-secret';
		const args = {
			submissionId: 'sub-capability-cleanup',
			threadId,
			prompt: 'Reconcile me',
			imageUploadIds: [] as Id<'imageUploads'>[],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		const created = await asUser.mutation(api.agentRuntime.createRun, {
			...args,
			executionSecret
		});

		await expect(
			t.mutation(api.agentRuntime.finalizeFailedStart, {
				...args,
				executionSecret,
				text: 'Run failed before the model started.',
				lastError: 'startup timed out'
			})
		).resolves.toBe('finalized');
		expect(await t.run(async (ctx) => (await ctx.db.get(created.runId))?.status)).toBe('failed');
	});

	it('reports pending while the submission has no run yet', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await expect(
			asUser.mutation(api.agentRuntime.finalizeFailedStart, {
				submissionId: 'sub-not-created-yet',
				threadId,
				prompt: 'Reconcile me',
				imageUploadIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				executionSecret: 'some-secret',
				text: 'Run failed before the model started.',
				lastError: 'startup timed out'
			})
		).resolves.toBe('pending');
	});

	it('tells the losing launch of a racing submission to stand down', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const args = {
			submissionId: 'sub-raced',
			threadId,
			prompt: 'Two launches, one submission',
			imageUploadIds: [] as Id<'imageUploads'>[],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		const created = await asUser.mutation(api.agentRuntime.createRun, {
			...args,
			executionSecret: 'loser-secret'
		});
		// The winning launch resumes the submission and rebinds its capability.
		await asUser.mutation(api.agentRuntime.createRun, {
			...args,
			executionSecret: 'winner-secret'
		});

		await expect(
			asUser.mutation(api.agentRuntime.finalizeFailedStart, {
				...args,
				executionSecret: 'loser-secret',
				text: 'Run failed before the model started.',
				lastError: 'lost the launch race'
			})
		).resolves.toBe('observed');
		expect(await t.run(async (ctx) => (await ctx.db.get(created.runId))?.status)).toBe('queued');
	});

	it('leaves a claimed run to its executor', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'claimed-secret';
		const args = {
			submissionId: 'sub-claimed',
			threadId,
			prompt: 'Already running',
			imageUploadIds: [] as Id<'imageUploads'>[],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		const created = await asUser.mutation(api.agentRuntime.createRun, {
			...args,
			executionSecret
		});
		await t.mutation(api.agentRuntime.start, {
			runId: created.runId,
			claimId: 'claim-claimed',
			executionSecret
		});

		await expect(
			asUser.mutation(api.agentRuntime.finalizeFailedStart, {
				...args,
				executionSecret,
				text: 'Run failed before the model started.',
				lastError: 'late cleanup'
			})
		).resolves.toBe('observed');
		expect(await t.run(async (ctx) => (await ctx.db.get(created.runId))?.status)).toBe('running');
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
			serviceTier: 'standard',
			executionSecret: 'active-first-secret'
		});

		await expect(
			asUser.mutation(api.agentRuntime.createRun, {
				submissionId: 'sub-next',
				threadId,
				prompt: 'Second',
				imageUploadIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				executionSecret: 'active-second-secret'
			})
		).rejects.toThrow('Finish or cancel the active run before sending another message.');
	});

	it('marks an abandoned claimed run as failed when a new submission arrives', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'abandoned-secret';
		const abandoned = await createQueuedRun(asUser, threadId, 'sub-abandoned', executionSecret);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-abandoned',
			runId: abandoned.runId,
			executionSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(abandoned.runId, { claimExpiresAt: Date.now() - 1 });
		});

		const next = await asUser.mutation(api.agentRuntime.createRun, {
			submissionId: 'sub-after-abandoned',
			threadId,
			prompt: 'Second',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			executionSecret: 'after-abandoned-secret'
		});
		expect(next.created).toBe(true);
		expect(next.runId).not.toBe(abandoned.runId);

		const abandonedRun = await t.run(async (ctx) => ctx.db.get(abandoned.runId));
		expect(abandonedRun).toMatchObject({
			status: 'failed',
			lastError: 'The local agent stopped responding before this run finished.'
		});
		const abandonedResponse = await t.run(async (ctx) =>
			abandonedRun?.responseMessageId ? ctx.db.get(abandonedRun.responseMessageId) : null
		);
		expect(abandonedResponse?.text).toBe(
			'Run aborted: The local agent stopped responding before this run finished.'
		);
	});

	it('rejects a new submission while the latest run holds an active claim', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'active-claim-secret';
		const { runId } = await createQueuedRun(asUser, threadId, 'sub-active-claim', executionSecret);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-active',
			runId,
			executionSecret
		});

		await expect(
			asUser.mutation(api.agentRuntime.createRun, {
				submissionId: 'sub-during-active-claim',
				threadId,
				prompt: 'Second',
				imageUploadIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				executionSecret: 'during-active-claim-secret'
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
			serviceTier: 'standard',
			executionSecret: 'completed-first-secret'
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
			serviceTier: 'standard',
			executionSecret: 'completed-second-secret'
		});
		expect(second.created).toBe(true);
		expect(second.runId).not.toBe(first.runId);
	});
});
