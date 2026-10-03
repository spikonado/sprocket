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

describe('workspace context snapshots', () => {
	it('pins the initial snapshot and ignores changed files on a retry', async () => {
		const { t, asUser, auth } = await setup();
		const initial = [{ beforePartNumber: 0, text: 'Original instructions and skills' }];
		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
				...auth,
				text: initial[0]!.text
			})
		).toEqual(initial);
		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
				...auth,
				text: 'Edited during this run'
			})
		).toEqual(initial);
		const snapshots = await t.run((ctx) => ctx.db.query('threadWorkspaceContexts').collect());
		expect(snapshots).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.get('runs', auth.runId))).toMatchObject({
			workspaceContextSnapshotId: snapshots[0]!._id
		});
	});

	it.each([
		{ changed: false, summarized: false },
		{ changed: true, summarized: false },
		{ changed: true, summarized: true }
	])(
		'preserves prompt history (changed=$changed, summarized=$summarized)',
		async ({ changed, summarized }) => {
			const fixture = await setup();
			const { t, asUser, threadId, auth } = fixture;
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, { ...auth, text: 'Original' });
			await finishRun(fixture, 'completed');

			if (summarized) {
				await t.run((ctx) =>
					ctx.db.patch('threadRecords', threadId, {
						contextSummary: 'Earlier work',
						contextSummaryThroughPartNumber: 0
					})
				);
			}

			const executionSecret = 'next-workspace-context-secret';
			const { runId } = await createQueuedRun(t, asUser, threadId, 'next-context', executionSecret);
			const nextAuth = { runId, claimId: 'next-context-claim', executionSecret };
			await asUser.mutation(api.agentRuntime.start, nextAuth);

			const expected = [
				{ beforePartNumber: 0, text: 'Original' },
				...(changed ? [{ beforePartNumber: 2, text: 'Updated' }] : [])
			];

			expect(
				await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
					...nextAuth,
					text: changed ? 'Updated' : 'Original'
				})
			).toEqual(expected);
			expect(
				await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
					...nextAuth,
					text: 'Another edit before a retry'
				})
			).toEqual(expected);
			const snapshots = await t.run((ctx) => ctx.db.query('threadWorkspaceContexts').collect());
			expect(snapshots).toHaveLength(changed ? 2 : 1);
			expect(await t.run((ctx) => ctx.db.get('runs', runId))).toMatchObject({
				workspaceContextSnapshotId: snapshots.at(-1)!._id
			});
		}
	);

	it('reuses the latest snapshot for a promptless continuation', async () => {
		const fixture = await setup();
		const { t, asUser, threadId, auth } = fixture;
		await asUser.mutation(api.agentRuntime.saveWorkspaceContext, { ...auth, text: 'Original' });
		await finishRun(fixture, 'failed');
		const executionSecret = 'continued-context-secret';

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'continued-context',
			executionSecret,
			prompt: '',
			continuationOfRunId: auth.runId
		});

		const continuationAuth = { runId, claimId: 'continued-context-claim', executionSecret };
		await asUser.mutation(api.agentRuntime.start, continuationAuth);
		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
				...continuationAuth,
				text: 'Edited after failure'
			})
		).toEqual([{ beforePartNumber: 0, text: 'Original' }]);
		expect(await t.run((ctx) => ctx.db.query('threadWorkspaceContexts').collect())).toHaveLength(1);
	});

	it('pins the handoff workspace context as the baseline for the resumed run', async () => {
		const fixture = await setup();
		const { t, asUser, threadId, auth } = fixture;
		await asUser.mutation(api.agentRuntime.saveWorkspaceContext, { ...auth, text: 'Original' });
		await finishRun(fixture, 'completed');

		const executionSecret = 'handoff-context-secret';

		const { runId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'handoff-context',
			executionSecret
		);

		const handoffAuth = { runId, claimId: 'handoff-context-claim', executionSecret };
		await asUser.mutation(api.agentRuntime.start, handoffAuth);
		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
				...handoffAuth,
				text: 'Original'
			})
		).toEqual([{ beforePartNumber: 0, text: 'Original' }]);

		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			...handoffAuth,
			attemptSeq: 1
		});
		await asUser.mutation(api.agentRuntime.finalizeCompletionCall, {
			...handoffAuth,
			attemptSeq: 1,
			streamId: 'handoff-completion',
			items: [{ type: 'text', id: 'handoff-text', text: 'Step done', turnId: 'handoff-turn' }],
			...emptyCompletionAssignments
		});
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
			...handoffAuth,
			attemptSeq: 2
		});

		const handoff = {
			...handoffAuth,
			summary: 'First step is done.',
			completionAttemptSeq: 2,
			beforePrompt: false,
			workspaceContext: 'Handoff context'
		};

		await expect(asUser.mutation(api.agentRuntime.saveContextHandoff, handoff)).resolves.toBe(true);
		await expect(asUser.mutation(api.agentRuntime.saveContextHandoff, handoff)).resolves.toBe(true);
		await expect(
			asUser.mutation(api.agentRuntime.saveContextHandoff, {
				...handoff,
				workspaceContext: 'Conflicting retry'
			})
		).rejects.toThrow('Conflicting workspace context handoff retry.');

		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
				...handoffAuth,
				text: 'Edited during the handoff'
			})
		).toEqual([{ beforePartNumber: 4, text: 'Handoff context' }]);
		expect(await t.run((ctx) => ctx.db.query('threadWorkspaceContexts').collect())).toHaveLength(2);
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret,
			expectedClaimId: handoffAuth.claimId,
			expectedStatus: 'running',
			text: '',
			status: 'completed'
		});

		const nextSecret = 'after-handoff-secret';

		const { runId: nextRunId } = await createQueuedRun(
			t,
			asUser,
			threadId,
			'after-handoff',
			nextSecret
		);

		const nextAuth = {
			runId: nextRunId,
			claimId: 'after-handoff-claim',
			executionSecret: nextSecret
		};

		await asUser.mutation(api.agentRuntime.start, nextAuth);
		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
				...nextAuth,
				text: 'Fresh context'
			})
		).toEqual([
			{ beforePartNumber: 4, text: 'Handoff context' },
			{ beforePartNumber: 4, text: 'Fresh context' }
		]);
		expect(await t.run((ctx) => ctx.db.query('threadWorkspaceContexts').collect())).toHaveLength(3);
	});

	it('rebuilds before the first prompt with a durable nonnegative handoff anchor', async () => {
		const { t, asUser, auth } = await setup();
		await asUser.mutation(api.agentRuntime.saveWorkspaceContext, { ...auth, text: 'Original' });
		await asUser.mutation(api.agentRuntime.registerCompletionAttempt, { ...auth, attemptSeq: 1 });

		const handoff = {
			...auth,
			summary: 'Ready for the first request.',
			completionAttemptSeq: 1,
			beforePrompt: true,
			workspaceContext: 'Latest context'
		};

		await asUser.mutation(api.agentRuntime.saveContextHandoff, handoff);
		await asUser.mutation(api.agentRuntime.saveContextHandoff, handoff);
		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, { ...auth, text: 'Later edit' })
		).toEqual([{ beforePartNumber: 0, text: 'Latest context' }]);
		expect(await t.run((ctx) => ctx.db.query('threadWorkspaceContexts').collect())).toHaveLength(2);
	});

	it('initializes an older promptless conversation without a saved snapshot', async () => {
		const fixture = await setup();
		const { t, asUser, threadId, auth } = fixture;
		await finishRun(fixture, 'failed');
		const executionSecret = 'legacy-continued-context-secret';

		const { runId } = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'legacy-continued-context',
			executionSecret,
			prompt: '',
			continuationOfRunId: auth.runId
		});

		const continuationAuth = { runId, claimId: 'legacy-context-claim', executionSecret };
		await asUser.mutation(api.agentRuntime.start, continuationAuth);
		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
				...continuationAuth,
				text: 'Current legacy context'
			})
		).toEqual([{ beforePartNumber: 0, text: 'Current legacy context' }]);
	});

	it('rejects stale and expired claims without saving snapshots', async () => {
		const { t, asUser, auth } = await setup();
		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, {
				...auth,
				claimId: 'stale-claim',
				text: 'Stale context'
			})
		).toBeNull();
		await t.run((ctx) => patchRunExecution(ctx, auth.runId, { claimExpiresAt: Date.now() - 1 }));
		expect(
			await asUser.mutation(api.agentRuntime.saveWorkspaceContext, { ...auth, text: 'Expired' })
		).toBeNull();
		expect(await t.run((ctx) => ctx.db.query('threadWorkspaceContexts').collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get('runs', auth.runId))).not.toHaveProperty(
			'workspaceContextSnapshotId'
		);
	});
});
