import { describe, expect, it } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import { createQueuedRun, initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

describe('agentRuntime.insertGatewayRun', () => {
	it('atomically creates a new thread with its first queued run', async () => {
		const t = initConvexTest();
		const userId = 'user_alice';
		const created = await t.mutation(internal.agentRuntime.insertGatewayRun, {
			userId,
			submissionId: 'new-thread-submission',
			repositoryKey: 'alpha',
			prompt: 'Build it',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'medium',
			serviceTier: 'standard',
			executionSecret: 'new-thread-secret',
			protocolVersion: 1
		});

		const [thread, run] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.get('threadRecords', created.threadId),
				ctx.db.get('runs', created.runId)
			])
		);
		expect(thread).toMatchObject({ userId, repositoryKey: 'alpha', status: 'queued' });
		expect(run).toMatchObject({ threadId: created.threadId, status: 'queued' });
	});

	it('rejects an empty prompt with no images', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await expect(
			insertQueuedRun(t, asUser, {
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
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const imageUploadId = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['image'], { type: 'image/png' }));
			return await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId,
				name: 'robot.png',
				mediaType: 'image/png',
				size: 5,
				attached: false
			});
		});
		const args = {
			submissionId: 'sub-1',
			threadId,
			prompt: 'Hello',
			imageUploadIds: [imageUploadId],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const,
			executionSecret: 'idempotent-secret'
		};

		const created = await insertQueuedRun(t, asUser, args);
		expect(created).toMatchObject({
			created: true,
			promptMessageId: `prompt:${created.runId}`
		});

		const again = await insertQueuedRun(t, asUser, args);
		expect(again).toEqual({
			created: false,
			runId: created.runId,
			threadId: created.threadId,
			promptMessageId: `prompt:${created.runId}`,
			userId: created.userId,
			promptPart: created.promptPart
		});
		expect(created.promptPart).toMatchObject({
			number: 0,
			sourceKey: `prompt:${created.runId}`,
			kind: 'prompt',
			runId: created.runId,
			prompt: {
				text: 'Hello',
				imageUploads: [
					{
						imageUploadId,
						name: 'robot.png',
						mediaType: 'image/png',
						size: 5,
						storageId: expect.any(String)
					}
				]
			}
		});

		const run = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(run).toMatchObject({
			status: 'queued',
			submissionId: 'sub-1',
			completionTransport: 'gateway'
		});
		expect(await t.run(async (ctx) => ctx.db.get('imageUploads', imageUploadId))).toMatchObject({
			attached: true
		});
	});

	it('lets the local executor continue without a browser identity using its run capability', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'executor-secret';
		const created = await insertQueuedRun(t, asUser, {
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
			await t.run(async (ctx) => (await ctx.db.get('runs', created.runId))?.executionSecretHash)
		).not.toBe(executionSecret);

		const expiredAt = await t.run(async (ctx) => {
			const claimExpiresAt = Date.now() - 1;
			await ctx.db.patch('runs', created.runId, { claimExpiresAt });
			return claimExpiresAt;
		});
		await expect(
			t.mutation(api.agentRuntime.renewClaim, {
				runId: created.runId,
				claimId: 'claim-local',
				executionSecret
			})
		).resolves.toMatchObject({ renewed: false });
		expect(
			await t.run(async (ctx) => (await ctx.db.get('runs', created.runId))?.claimExpiresAt)
		).toBe(expiredAt);
	});

	it('never rebinds a queued submission to a different executor', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const args = {
			submissionId: 'sub-rebind',
			threadId,
			prompt: 'Recover this launch',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		const created = await insertQueuedRun(t, asUser, {
			...args,
			executionSecret: 'lost-secret'
		});

		await expect(
			insertQueuedRun(t, asUser, {
				...args,
				executionSecret: 'replacement-secret'
			})
		).rejects.toThrow('Submission belongs to a different executor.');
		await expect(
			t.mutation(api.agentRuntime.start, {
				runId: created.runId,
				claimId: 'original-claim',
				executionSecret: 'lost-secret'
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
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		const created = await insertQueuedRun(t, asUser, {
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
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', created.runId))?.status)).toBe(
			'failed'
		);
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

	it('finalizes with the original capability when a duplicate launch is rejected', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const args = {
			submissionId: 'sub-rebound-anonymous',
			threadId,
			prompt: 'Two launches, one submission',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		await insertQueuedRun(t, asUser, {
			...args,
			executionSecret: 'loser-secret'
		});
		await expect(
			insertQueuedRun(t, asUser, { ...args, executionSecret: 'winner-secret' })
		).rejects.toThrow('Submission belongs to a different executor.');
		await expect(
			t.mutation(api.agentRuntime.finalizeFailedStart, {
				...args,
				executionSecret: 'loser-secret',
				text: 'Run failed before the model started.',
				lastError: 'original launch failed'
			})
		).resolves.toBe('finalized');
	});

	it('tells the losing launch of a racing submission to stand down', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const args = {
			submissionId: 'sub-raced',
			threadId,
			prompt: 'Two launches, one submission',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		const created = await insertQueuedRun(t, asUser, {
			...args,
			executionSecret: 'loser-secret'
		});
		await expect(
			insertQueuedRun(t, asUser, { ...args, executionSecret: 'winner-secret' })
		).rejects.toThrow('Submission belongs to a different executor.');

		await expect(
			asUser.mutation(api.agentRuntime.finalizeFailedStart, {
				...args,
				executionSecret: 'winner-secret',
				text: 'Run failed before the model started.',
				lastError: 'lost the launch race'
			})
		).resolves.toBe('standDown');
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', created.runId))?.status)).toBe(
			'queued'
		);
	});

	it('leaves a claimed run to its executor', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'claimed-secret';
		const args = {
			submissionId: 'sub-claimed',
			threadId,
			prompt: 'Already running',
			imageUploadIds: [],
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			serviceTier: 'standard' as const
		};
		const created = await insertQueuedRun(t, asUser, {
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
		).resolves.toBe('standDown');
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', created.runId))?.status)).toBe(
			'running'
		);
	});

	it('keeps the submission conflict message readable for the losing launch', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const created = await createQueuedRun(t, asUser, threadId, 'sub-owned', 'owner-secret');
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-owner',
			runId: created.runId,
			executionSecret: 'owner-secret'
		});

		// The executor matches on this exact text when standing down a racing
		// launch, so it must survive production error masking.
		await expect(
			insertQueuedRun(t, asUser, {
				submissionId: 'sub-owned',
				threadId,
				prompt: 'Do the thing',
				imageUploadIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				executionSecret: 'intruder-secret'
			})
		).rejects.toThrow('Submission belongs to a different executor.');
	});

	it('rejects a second run while the thread has an active run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await insertQueuedRun(t, asUser, {
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
			insertQueuedRun(t, asUser, {
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
		const abandoned = await createQueuedRun(t, asUser, threadId, 'sub-abandoned', executionSecret);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-abandoned',
			runId: abandoned.runId,
			executionSecret
		});
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', abandoned.runId, { claimExpiresAt: Date.now() - 1 });
		});

		const next = await insertQueuedRun(t, asUser, {
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

		const abandonedRun = await t.run(async (ctx) => ctx.db.get('runs', abandoned.runId));
		expect(abandonedRun).toMatchObject({
			status: 'failed',
			lastError: 'The local agent stopped responding before this run finished.'
		});
		// Aborted terminal text is not preserved: only runs and transcript
		// parts written by completed model calls hold response content.
	});

	it('rejects a new submission while the latest run holds an active claim', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const executionSecret = 'active-claim-secret';
		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-active-claim',
			executionSecret
		);
		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-active',
			runId,
			executionSecret
		});

		await expect(
			insertQueuedRun(t, asUser, {
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

		const first = await insertQueuedRun(t, asUser, {
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
			await ctx.db.patch('runs', first.runId, { status: 'completed', completedAt: Date.now() });
		});

		const second = await insertQueuedRun(t, asUser, {
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
