import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { patchRunExecution } from '@convex/lib/runExecution';
import {
	createQueuedRun,
	emptyCompletionAssignments,
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread
} from './test.setup';

async function setup() {
	const t = initConvexTest();
	const { asUser, threadId } = await seedOwnedThread(t);
	const executionSecret = 'workspace-context-secret';

	const { runId } = await createQueuedRun(
		t,
		asUser,
		threadId,
		'workspace-context',
		executionSecret
	);

	const auth = { runId, claimId: 'workspace-context-claim', executionSecret };
	await asUser.mutation(api.agentRuntime.start, auth);

	return { t, asUser, threadId, auth };
}

async function finishRun(
	fixture: Awaited<ReturnType<typeof setup>>,
	status: 'completed' | 'failed'
) {
	const { asUser, auth } = fixture;
	await asUser.mutation(api.agentRuntime.registerCompletionAttempt, { ...auth, attemptSeq: 1 });
	await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
		...auth,
		attemptSeq: 1,
		streamId: 'workspace-context-completion',
		items: [{ type: 'text', id: 'context-text', text: 'Done', turnId: 'context-turn' }],
		...emptyCompletionAssignments
	});
	await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
		runId: auth.runId,
		executionSecret: auth.executionSecret,
		expectedClaimId: auth.claimId,
		expectedStatus: 'running',
		text: '',
		status
	});
}

describe('workspace prompt preparation', () => {
	it('stores the initial preamble on the prompt and freezes it on retry', async () => {
		const { t, asUser, threadId, auth } = await setup();

		const initial = {
			prompt: {
				text: 'Do the thing',
				imageUploads: [],
				workspaceContext: 'Original instructions and skills'
			},
			workspaceContext: 'Original instructions and skills'
		};

		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...auth,
				text: 'Original instructions and skills'
			})
		).toEqual(initial);
		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...auth,
				text: 'Edited during this run'
			})
		).toEqual(initial);

		const prompt = await t.run((ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_kind_and_number', (q) =>
					q.eq('threadId', threadId).eq('kind', 'prompt')
				)
				.first()
		);

		expect(prompt?.prompt?.workspaceContext).toBe('Original instructions and skills');
		expect(prompt?.prompt?.text).toBe('Do the thing');
		expect(
			await createQueuedRun(t, asUser, threadId, 'workspace-context', auth.executionSecret)
		).toMatchObject({ runId: auth.runId, created: false });
	});

	it('reuses a prepared preamble without scanning large earlier prompts', async () => {
		const { t, asUser, threadId, auth } = await setup();
		const userId = (await t.run((ctx) => ctx.db.get('threadRecords', threadId)))!.userId;
		await t.run(async (ctx) => {
			const part = await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_runId_and_number', (q) =>
					q.eq('threadId', threadId).eq('runId', auth.runId)
				)
				.first();

			await ctx.db.patch('threadTranscriptParts', part!._id, {
				number: 24,
				prompt: { ...part!.prompt!, workspaceContext: 'Pinned context' }
			});
		});

		for (let batch = 0; batch < 3; batch++) {
			await t.run(async (ctx) => {
				for (let offset = 0; offset < 8; offset++) {
					const number = batch * 8 + offset;
					await ctx.db.insert('threadTranscriptParts', {
						threadId,
						userId,
						runId: auth.runId,
						sourceKey: `historical:${number}`,
						number,
						kind: 'prompt',
						prompt: { text: 'x'.repeat(768 * 1024), imageUploads: [] },
						work: { ranges: [] }
					});
				}
			});
		}

		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...auth,
				text: 'Edited on retry'
			})
		).toEqual({
			prompt: { text: 'Do the thing', imageUploads: [], workspaceContext: 'Pinned context' },
			workspaceContext: 'Pinned context'
		});
	});

	it.each([{ changed: false }, { changed: true }])(
		'appends the preamble only when it changed (changed=$changed)',
		async ({ changed }) => {
			const fixture = await setup();
			const { t, asUser, threadId, auth } = fixture;
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, { ...auth, text: 'Original' });
			await finishRun(fixture, 'completed');

			const executionSecret = 'next-workspace-context-secret';
			const { runId } = await createQueuedRun(t, asUser, threadId, 'next-context', executionSecret);
			const nextAuth = { runId, claimId: 'next-context-claim', executionSecret };
			await asUser.mutation(api.agentRuntime.start, nextAuth);

			const expected = {
				prompt: {
					text: 'Do the thing',
					imageUploads: [],
					workspaceContext: changed ? 'Updated' : null
				},
				workspaceContext: changed ? 'Updated' : 'Original'
			};

			expect(
				await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
					...nextAuth,
					text: changed ? 'Updated' : 'Original'
				})
			).toEqual(expected);
			expect(
				await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
					...nextAuth,
					text: 'Another edit before a retry'
				})
			).toEqual(expected);
		}
	);

	it('reports oversized combined prompts and allows retry after reducing the preamble', async () => {
		const { t, asUser, threadId, auth } = await setup();
		const text = 'é'.repeat(400 * 1024);
		await t.run(async (ctx) => {
			const part = await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_kind_and_number', (q) =>
					q.eq('threadId', threadId).eq('kind', 'prompt')
				)
				.first();

			await ctx.db.patch('threadTranscriptParts', part!._id, {
				prompt: { ...part!.prompt!, text }
			});
		});

		await expect(
			asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...auth,
				text: 'é'.repeat(200 * 1024)
			})
		).rejects.toThrow('User prompt and workspace context exceed the 1 MiB transcript limit');

		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...auth,
				text: 'Reduced preamble'
			})
		).toEqual({
			prompt: { text, imageUploads: [], workspaceContext: 'Reduced preamble' },
			workspaceContext: 'Reduced preamble'
		});
	});

	it('keeps the stored preamble for a promptless continuation', async () => {
		const fixture = await setup();
		const { t, asUser, threadId, auth } = fixture;
		await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, { ...auth, text: 'Original' });
		await finishRun(fixture, 'failed');

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'continued-context',
			executionSecret: 'continued-context-secret',
			prompt: '',
			continuationOfRunId: auth.runId
		});

		const continuationAuth = {
			runId,
			claimId: 'continued-context-claim',
			executionSecret: 'continued-context-secret'
		};

		await asUser.mutation(api.agentRuntime.start, continuationAuth);
		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...continuationAuth,
				text: 'Edited after failure'
			})
		).toEqual({ prompt: null, workspaceContext: 'Original' });
	});

	it('returns an ephemeral initial context for a legacy promptless conversation', async () => {
		const fixture = await setup();
		const { t, asUser, threadId, auth } = fixture;
		await finishRun(fixture, 'failed');

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'legacy-continued-context',
			executionSecret: 'legacy-continued-context-secret',
			prompt: '',
			continuationOfRunId: auth.runId
		});

		const continuationAuth = {
			runId,
			claimId: 'legacy-context-claim',
			executionSecret: 'legacy-continued-context-secret'
		};

		await asUser.mutation(api.agentRuntime.start, continuationAuth);
		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...continuationAuth,
				text: 'Current legacy context'
			})
		).toEqual({
			prompt: null,
			workspaceContext: 'Current legacy context',
			initialWorkspaceContext: 'Current legacy context'
		});
	});

	it('does not append a changed preamble to a completed legacy run', async () => {
		const fixture = await setup();
		const { t, asUser, threadId } = fixture;
		await finishRun(fixture, 'completed');

		const executionSecret = 'legacy-next-secret';
		const { runId } = await createQueuedRun(t, asUser, threadId, 'legacy-next', executionSecret);
		const nextAuth = { runId, claimId: 'legacy-next-claim', executionSecret };
		await asUser.mutation(api.agentRuntime.start, nextAuth);
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			...nextAuth,
			attemptSeq: 1
		});
		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			...nextAuth,
			attemptSeq: 1,
			streamId: 'legacy-next-completion',
			items: [{ type: 'text', id: 'legacy-next-text', text: 'Done', turnId: 'legacy-next-turn' }],
			...emptyCompletionAssignments
		});

		const expected = {
			prompt: { text: 'Do the thing', imageUploads: [] },
			workspaceContext: 'Late edit',
			initialWorkspaceContext: 'Late edit'
		};

		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...nextAuth,
				text: 'Late edit'
			})
		).toEqual(expected);
		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...nextAuth,
				text: 'Later edit'
			})
		).toEqual({
			...expected,
			workspaceContext: 'Later edit',
			initialWorkspaceContext: 'Later edit'
		});

		const prompt = await t.run((ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_runId_and_number', (q) =>
					q.eq('threadId', threadId).eq('runId', runId)
				)
				.first()
		);

		expect(prompt?.prompt).not.toHaveProperty('workspaceContext');
	});

	it('rejects stale and expired claims without touching the prompt', async () => {
		const { t, asUser, threadId, auth } = await setup();
		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, {
				...auth,
				claimId: 'stale-claim',
				text: 'Stale context'
			})
		).toBeNull();
		await t.run((ctx) => patchRunExecution(ctx, auth.runId, { claimExpiresAt: Date.now() - 1 }));
		expect(
			await asUser.mutation(api.agentRuntime.prepareWorkspacePrompt, { ...auth, text: 'Expired' })
		).toBeNull();

		const prompt = await t.run((ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_runId_and_number', (q) =>
					q.eq('threadId', threadId).eq('runId', auth.runId)
				)
				.first()
		);

		expect(prompt?.prompt).not.toHaveProperty('workspaceContext');
	});
});

describe('context handoff workspace preamble', () => {
	it('prepends the preamble to the stored summary and rejects conflicting retries', async () => {
		const fixture = await setup();
		const { t, asUser, threadId, auth } = fixture;
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, { ...auth, attemptSeq: 1 });

		const handoff = {
			...auth,
			summary: 'Ready for the next request.',
			completionAttemptSeq: 1,
			beforePrompt: true,
			workspaceContext: 'Latest context'
		};

		await expect(asUser.mutation(api.agentRuntime.saveContextHandoff, handoff)).resolves.toBe(true);
		await expect(asUser.mutation(api.agentRuntime.saveContextHandoff, handoff)).resolves.toBe(true);
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				...handoff,
				workspaceContext: 'Conflicting retry'
			})
		).rejects.toThrow('Conflicting context handoff retry.');

		expect(await t.run((ctx) => ctx.db.get('threadRecords', threadId))).toMatchObject({
			contextSummary: 'Latest context\n\nReady for the next request.'
		});
	});

	it('accepts released callers without the optional preamble argument', async () => {
		const fixture = await setup();
		const { t, asUser, threadId, auth } = fixture;
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, { ...auth, attemptSeq: 1 });

		const handoff = {
			...auth,
			summary: 'Ready for the next request.',
			completionAttemptSeq: 1,
			beforePrompt: true
		};

		await asUser.mutation(api.agentRuntime.saveContextHandoff, handoff);
		await expect(asUser.mutation(api.agentRuntime.saveContextHandoff, handoff)).resolves.toBe(true);

		expect(await t.run((ctx) => ctx.db.get('threadRecords', threadId))).toMatchObject({
			contextSummary: 'Ready for the next request.'
		});
	});
});
