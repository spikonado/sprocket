import { describe, expect, it } from 'vitest';
import { patchRunExecution } from '@convex/lib/runExecution';
import { api } from '@convex/_generated/api';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { ONLY_LATEST_RUN_CAN_CONTINUE, RUN_CANNOT_CONTINUE } from '@convex/lib/runResume';
import { createQueuedRun, initConvexTest, insertQueuedRun, seedOwnedThread } from './test.setup';

describe('new-run continuation', { timeout: 30_000 }, () => {
	it('creates a linked run without a visible prompt and is idempotent', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const parent = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-parent',
			'parent-secret',
			'$deploy'
		);

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: parent.runId,
			text: '',
			status: 'failed',
			lastError: 'boom',
			executionSecret: 'parent-secret'
		});

		const args = {
			threadId,
			submissionId: 'sub-continue',
			executionSecret: 'continue-secret',
			prompt: '',
			continuationOfRunId: parent.runId,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'high' as const,
			fastMode: true
		};

		const created = await insertQueuedRun(t, asUser, args);
		expect(created).toMatchObject({ created: true, runId: expect.any(String) });
		expect(created.promptPart).toBeUndefined();
		expect(created.runId).not.toBe(parent.runId);

		const again = await insertQueuedRun(t, asUser, args);
		expect(again).toMatchObject({ created: false, runId: created.runId });

		const continuation = await t.run(async (ctx) => ctx.db.get('runs', created.runId));
		expect(continuation).toMatchObject({
			status: 'queued',
			continuationOfRunId: parent.runId,
			selectedModel: 'gpt-5.6-sol',
			reasoningEffort: 'high',
			fastMode: true,
			submissionId: 'sub-continue'
		});
		expect(continuation).not.toHaveProperty('serviceTier');

		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts.map((part) => [part.number, part.kind, part.runId])).toEqual([
			[0, 'prompt', parent.runId]
		]);

		const context = await asUser.query(api.agentRuntime.getContext, {
			runId: created.runId,
			executionSecret: 'continue-secret'
		});

		expect(context).toMatchObject({
			prompt: '',
			invocationPrompt: '$deploy',
			invocationPromptIsUser: true
		});
		expect(context.run.continuationOfRunId).toBe(parent.runId);
	});

	it('creates a linked continuation with a visible prompt from a completed run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const parent = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-answered-parent',
			'parent-secret',
			'$deploy'
		);

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: parent.runId,
			text: '',
			status: 'completed',
			executionSecret: 'parent-secret'
		});
		await expect(
			insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'sub-empty-completed-continuation',
				executionSecret: 'empty-completed-continuation-secret',
				prompt: '',
				continuationOfRunId: parent.runId
			})
		).rejects.toThrow(RUN_CANNOT_CONTINUE);

		const args = {
			threadId,
			submissionId: 'sub-answered-continuation',
			executionSecret: 'answered-continuation-secret',
			prompt: 'Ship it: include the release notes',
			continuationOfRunId: parent.runId
		};

		const created = await insertQueuedRun(t, asUser, args);
		expect(created).toMatchObject({
			created: true,
			promptPart: {
				kind: 'prompt',
				prompt: { text: args.prompt }
			}
		});
		expect(await t.run(async (ctx) => ctx.db.get('runs', created.runId))).toMatchObject({
			continuationOfRunId: parent.runId
		});
		expect(
			await asUser.query(api.agentRuntime.getContext, {
				runId: created.runId,
				executionSecret: args.executionSecret
			})
		).toMatchObject({
			prompt: args.prompt,
			invocationPrompt: args.prompt,
			invocationPromptIsUser: true
		});

		await expect(insertQueuedRun(t, asUser, args)).resolves.toMatchObject({
			created: false,
			runId: created.runId,
			promptPart: { prompt: { text: args.prompt } }
		});
		await expect(
			insertQueuedRun(t, asUser, { ...args, prompt: 'A different answer' })
		).rejects.toThrow('Submission prompt does not match the existing run.');

		const parts = await asUser.query(api.transcript.getParts, { threadId, numbers: [0, 1] });
		expect(parts.parts.map((part) => [part.runId, part.prompt?.text])).toEqual([
			[parent.runId, '$deploy'],
			[created.runId, args.prompt]
		]);

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: created.runId,
			executionSecret: args.executionSecret,
			text: '',
			status: 'failed'
		});

		const recovery = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'newer-prompt-recovery',
			executionSecret: 'newer-prompt-recovery-secret',
			prompt: '',
			continuationOfRunId: created.runId
		});

		expect(
			await asUser.query(api.agentRuntime.getContext, {
				runId: recovery.runId,
				executionSecret: 'newer-prompt-recovery-secret'
			})
		).toMatchObject({ prompt: '', invocationPrompt: args.prompt, invocationPromptIsUser: true });
	});

	it('uses an attachment-only request instead of an earlier skill invocation on recovery', async () => {
		const t = initConvexTest();
		const { asUser, threadId, subject } = await seedOwnedThread(t);

		const parent = await createQueuedRun(
			t,
			asUser,
			threadId,
			'attachment-parent',
			'parent-secret',
			'$deploy'
		);

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: parent.runId,
			executionSecret: 'parent-secret',
			text: '',
			status: 'completed'
		});

		const imageUploadId = await t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(['notes'], { type: 'text/plain' }));

			return await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId,
				name: 'notes.txt',
				mediaType: 'text/plain',
				size: 5,
				attached: false
			});
		});

		const attachmentRequest = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'attachment-request',
			executionSecret: 'attachment-secret',
			prompt: '',
			imageUploadIds: [imageUploadId],
			continuationOfRunId: parent.runId
		});

		expect(attachmentRequest.promptPart?.prompt?.text).toBe('');
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: attachmentRequest.runId,
			executionSecret: 'attachment-secret',
			text: '',
			status: 'failed'
		});

		const recovery = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'attachment-recovery',
			executionSecret: 'attachment-recovery-secret',
			prompt: '',
			continuationOfRunId: attachmentRequest.runId
		});

		expect(
			await asUser.query(api.agentRuntime.getContext, {
				runId: recovery.runId,
				executionSecret: 'attachment-recovery-secret'
			})
		).toMatchObject({ prompt: '', invocationPrompt: '', invocationPromptIsUser: true });
	});

	it.each([64, 65])(
		'resolves a continuation chain of %i hops within the lookup bound',
		async (hops) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);

			const parent = await createQueuedRun(
				t,
				asUser,
				threadId,
				'bounded-parent',
				'parent-secret',
				'$deploy'
			);

			const runId = await t.run(async (ctx) => {
				const parentRun = await ctx.db.get('runs', parent.runId);

				if (!parentRun) throw new Error('Missing test run.');
				let continuationOfRunId = parentRun._id;

				for (let index = 0; index < hops; index++) {
					continuationOfRunId = await ctx.db.insert('runs', {
						threadId,
						userId: parentRun.userId,
						status: 'queued',
						executionSecretHash: parentRun.executionSecretHash,
						selectedModel: parentRun.selectedModel,
						reasoningEffort: parentRun.reasoningEffort,
						fastMode: parentRun.fastMode,
						startedAt: parentRun.startedAt,
						modelInitiated: false,
						submissionId: `bounded-continuation-${index}`,
						continuationOfRunId
					});
				}

				return continuationOfRunId;
			});

			expect(
				await t.query(api.agentRuntime.getContext, { runId, executionSecret: 'parent-secret' })
			).toMatchObject({
				prompt: '',
				invocationPrompt: hops === 64 ? '$deploy' : '',
				invocationPromptIsUser: hops === 64
			});
		}
	);

	it.each(['other user', 'other thread', 'missing run', 'cycle'])(
		'withholds invocation authorization for a continuation linked to %s',
		async (invalidLink) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);

			const parent = await createQueuedRun(
				t,
				asUser,
				threadId,
				'invalid-parent',
				'parent-secret',
				'$deploy'
			);

			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId: parent.runId,
				executionSecret: 'parent-secret',
				text: '',
				status: 'failed'
			});

			const recovery = await insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'invalid-recovery',
				executionSecret: 'recovery-secret',
				prompt: '',
				continuationOfRunId: parent.runId
			});

			const { threadId: otherThreadId } = await seedOwnedThread(t);
			await t.run(async (ctx) => {
				if (invalidLink === 'other user') {
					await ctx.db.patch('runs', parent.runId, { userId: 'another-user' });
				} else if (invalidLink === 'other thread') {
					await ctx.db.patch('runs', parent.runId, { threadId: otherThreadId });
				} else if (invalidLink === 'missing run') {
					await ctx.db.delete('runs', parent.runId);
				} else {
					await ctx.db.patch('runs', recovery.runId, { continuationOfRunId: recovery.runId });
				}
			});
			expect(
				await t.query(api.agentRuntime.getContext, {
					runId: recovery.runId,
					executionSecret: 'recovery-secret'
				})
			).toMatchObject({ prompt: '', invocationPrompt: '', invocationPromptIsUser: false });
		}
	);

	it('rejects active and non-latest parents', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const active = await createQueuedRun(t, asUser, threadId, 'sub-active', 'active-secret');
		await expect(
			insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'sub-continue-active',
				executionSecret: 'continue-active-secret',
				prompt: '',
				continuationOfRunId: active.runId
			})
		).rejects.toThrow(
			'Stop the current run or wait for it to finish before sending another message.'
		);

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: active.runId,
			text: '',
			status: 'completed',
			executionSecret: 'active-secret'
		});

		const failed = await createQueuedRun(t, asUser, threadId, 'sub-failed', 'failed-secret');
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: failed.runId,
			text: '',
			status: 'failed',
			lastError: 'boom',
			executionSecret: 'failed-secret'
		});

		const first = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'sub-continue-first',
			executionSecret: 'continue-first-secret',
			prompt: '',
			continuationOfRunId: failed.runId
		});

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: first.runId,
			text: '',
			status: 'cancelled',
			executionSecret: 'continue-first-secret'
		});
		await expect(
			insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'sub-continue-stale',
				executionSecret: 'continue-stale-secret',
				prompt: '',
				continuationOfRunId: failed.runId
			})
		).rejects.toThrow(ONLY_LATEST_RUN_CAN_CONTINUE);
	});

	it('rejects a second continuation while the first is still the latest run', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const parent = await createQueuedRun(t, asUser, threadId, 'sub-race-parent', 'race-parent');
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: parent.runId,
			text: '',
			status: 'cancelled',
			executionSecret: 'race-parent'
		});
		await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'sub-race-one',
			executionSecret: 'race-one',
			prompt: '',
			continuationOfRunId: parent.runId
		});
		await expect(
			insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'sub-race-two',
				executionSecret: 'race-two',
				prompt: '',
				continuationOfRunId: parent.runId
			})
		).rejects.toThrow(
			'Stop the current run or wait for it to finish before sending another message.'
		);
	});

	it('fails an abandoned claimed parent, then continues from it', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const abandoned = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-abandoned-continue',
			'abandoned-continue'
		);

		await asUser.mutation(api.agentRuntime.start, {
			claimId: 'claim-abandoned-continue',
			runId: abandoned.runId,
			executionSecret: 'abandoned-continue'
		});
		await t.run(async (ctx) => {
			await patchRunExecution(ctx, abandoned.runId, { claimExpiresAt: Date.now() - 1 });
		});

		const continuation = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'sub-after-abandoned-continue',
			executionSecret: 'after-abandoned-continue',
			prompt: '',
			continuationOfRunId: abandoned.runId
		});

		expect(continuation.created).toBe(true);
		expect(continuation.runId).not.toBe(abandoned.runId);
		expect(await t.run(async (ctx) => ctx.db.get('runs', abandoned.runId))).toMatchObject({
			status: 'failed',
			lastError: RUN_ABANDONED_BY_AGENT
		});
		expect(await t.run(async (ctx) => ctx.db.get('runs', continuation.runId))).toMatchObject({
			continuationOfRunId: abandoned.runId,
			status: 'queued'
		});
	});

	it('reconciles a queued continuation after a failed start', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		const parent = await createQueuedRun(
			t,
			asUser,
			threadId,
			'sub-cleanup-parent',
			'cleanup-parent'
		);

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: parent.runId,
			text: '',
			status: 'failed',
			lastError: 'boom',
			executionSecret: 'cleanup-parent'
		});

		const args = {
			submissionId: 'sub-cleanup-continue',
			threadId,
			prompt: '',
			selectedModel: 'gpt-5.6-sol' as const,
			reasoningEffort: 'medium' as const,
			fastMode: false
		};

		const created = await insertQueuedRun(t, asUser, {
			...args,
			executionSecret: 'cleanup-continue',
			continuationOfRunId: parent.runId
		});

		await expect(
			t.mutation(api.agentRuntime.finalizeFailedStart, {
				...args,
				storageIds: [],
				executionSecret: 'cleanup-continue',
				text: 'Run failed before the model started.',
				lastError: 'startup timed out'
			})
		).resolves.toBe('finalized');
		expect(await t.run(async (ctx) => (await ctx.db.get('runs', created.runId))?.status)).toBe(
			'failed'
		);
	});
});
