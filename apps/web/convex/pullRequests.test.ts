import { describe, expect, it, vi } from 'vitest';

import { api } from '@convex/_generated/api';
import { patchRunExecution } from '@convex/lib/runExecution';
import {
	AUTOMATIC_RECOVERY_GRACE_MS,
	AUTOMATIC_RECOVERY_SUBMISSION_PREFIX
} from '@convex/lib/runRecovery';
import {
	abandonRun,
	createQueuedRun,
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	toolTranscriptAssignment,
	type ConvexTestInstance
} from '@convex/test.setup';

const pr = (
	number: number,
	state: 'open' | 'closed' | 'merged',
	repository = 'github.com/acme/widgets',
	title = `PR ${number}`
) => ({ repository, number, state, title });

async function startRun(t: ConvexTestInstance) {
	const { asUser, threadId } = await seedOwnedThread(t);
	const executionSecret = 'pr-secret';
	const created = await createQueuedRun(t, asUser, threadId, 'pr-run', executionSecret);
	const claimId = 'pr-claim';

	await t.mutation(api.agentRuntime.start, { runId: created.runId, claimId, executionSecret });

	return { asUser, threadId, caller: { runId: created.runId, claimId, executionSecret } };
}

describe('linked pull requests', () => {
	it('adds new links after earlier ones and updates relinked PRs in place', async () => {
		const t = initConvexTest();
		const { threadId, caller } = await startRun(t);

		await t.mutation(api.pullRequests.link, { ...caller, pullRequests: [pr(12, 'open')] });

		await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(7, 'merged'), pr(12, 'closed'), pr(12, 'open', 'github.com/acme/site')]
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.pullRequests).toEqual([
			pr(12, 'closed'),
			pr(7, 'merged'),
			pr(12, 'open', 'github.com/acme/site')
		]);
	});

	it('updates only states and titles of PRs linked to threads the user owns', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(3, 'open'), pr(12, 'open'), pr(12, 'open', 'github.com/acme/site')]
		});

		await asUser.mutation(api.pullRequests.updateStates, {
			updates: [
				{ threadId, ...pr(3, 'closed') },
				{ threadId, ...pr(12, 'merged') },
				{ threadId, ...pr(12, 'open', 'github.com/acme/site', 'Renamed') },
				{ threadId, ...pr(99, 'open') }
			]
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.pullRequests).toEqual([
			pr(3, 'closed'),
			pr(12, 'merged'),
			pr(12, 'open', 'github.com/acme/site', 'Renamed')
		]);
		await expect(
			t.withIdentity({ subject: 'user_bob' }).mutation(api.pullRequests.updateStates, {
				updates: [{ threadId, ...pr(3, 'open') }]
			})
		).rejects.toThrow(/not found/i);
	});

	it('caps links per thread', async () => {
		const t = initConvexTest();
		const { caller } = await startRun(t);

		await expect(
			t.mutation(api.pullRequests.link, {
				...caller,
				pullRequests: Array.from({ length: 21 }, (_, index) => pr(index + 1, 'open'))
			})
		).rejects.toThrow(/at most 20 PRs/);
	});

	it.each([true, false])(
		'settles a thread once all its PRs merge when the setting is %s',
		async (enabled) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);

			await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled });
			await t.run((ctx) =>
				ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open'), pr(2, 'open')] })
			);

			const archivedAt = async () =>
				(await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt;

			await asUser.mutation(api.pullRequests.updateStates, {
				updates: [{ threadId, ...pr(1, 'merged') }]
			});
			expect(await archivedAt()).toBeUndefined();

			await asUser.mutation(api.pullRequests.updateStates, {
				updates: [{ threadId, ...pr(2, 'merged') }]
			});

			const settled = await t.run((ctx) => ctx.db.get('threadRecords', threadId));

			expect(settled?.archivedAt !== undefined).toBe(enabled);
			expect(settled?.settleWhenIdle).toBeUndefined();
		}
	);

	it('restores a pending settle when new work unarchives a settled merged thread', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open')] })
		);
		await asUser.mutation(api.pullRequests.updateStates, {
			updates: [{ threadId, ...pr(1, 'merged') }]
		});

		const settled = await t.run((ctx) => ctx.db.get('threadRecords', threadId));

		expect(settled?.archivedAt).toBeTypeOf('number');
		expect(settled?.settleWhenIdle).toBeUndefined();

		await createQueuedRun(t, asUser, threadId, 'follow-up', 'follow-up-secret');

		const continued = await t.run((ctx) => ctx.db.get('threadRecords', threadId));

		expect(continued?.archivedAt).toBeUndefined();
		expect(continued?.settleWhenIdle).toBe(true);
	});

	it('does not restore a pending settle after a manual unsettle', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open')] })
		);
		await asUser.mutation(api.pullRequests.updateStates, {
			updates: [{ threadId, ...pr(1, 'merged') }]
		});
		await asUser.mutation(api.threads.unsettle, { threadId });

		await createQueuedRun(t, asUser, threadId, 'follow-up', 'follow-up-secret');

		const continued = await t.run((ctx) => ctx.db.get('threadRecords', threadId));

		expect(continued?.archivedAt).toBeUndefined();
		expect(continued?.settleWhenIdle).toBeUndefined();
	});

	it.each([
		['has active work', true],
		['was unsettled after its PRs merged', false]
	])('leaves a thread unsettled when it %s', async (_, active) => {
		const t = initConvexTest();
		const started = active ? await startRun(t) : await seedOwnedThread(t);
		const { asUser, threadId } = started;

		const merge = (title?: string) =>
			asUser.mutation(api.pullRequests.updateStates, {
				updates: [{ threadId, ...pr(1, 'merged', undefined, title) }]
			});

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open')] })
		);
		await merge();

		if (!active) {
			await asUser.mutation(api.threads.unsettle, { threadId });
			await merge('Renamed');
		}

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.archivedAt).toBeUndefined();
		expect(thread?.settleWhenIdle).toBe(active || undefined);
	});

	it('settles after the run finishes when PRs merged while it was still working', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open')] })
		);
		await asUser.mutation(api.pullRequests.updateStates, {
			updates: [{ threadId, ...pr(1, 'merged') }]
		});

		const pending = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(pending?.archivedAt).toBeUndefined();
		expect(pending?.settleWhenIdle).toBe(true);

		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: caller.runId,
			expectedClaimId: caller.claimId,
			executionSecret: caller.executionSecret,
			status: 'completed',
			text: 'done'
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.archivedAt).toBeTypeOf('number');
		expect(thread?.settleWhenIdle).toBeUndefined();
	});

	it('settles after the run finishes when the agent linked already-merged PRs', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(1, 'merged')]
		});

		const pending = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(pending?.archivedAt).toBeUndefined();
		expect(pending?.settleWhenIdle).toBe(true);

		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: caller.runId,
			expectedClaimId: caller.claimId,
			executionSecret: caller.executionSecret,
			status: 'completed',
			text: 'done'
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.archivedAt).toBeTypeOf('number');
		expect(thread?.settleWhenIdle).toBeUndefined();
	});

	it('keeps a pending settle across a question continuation', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(1, 'merged')]
		});

		await t.mutation(api.agentRuntime.beginToolJob, {
			...caller,
			...toolTranscriptAssignment(caller.runId, caller.claimId),
			kind: 'ask_question',
			payload: { question: 'Ship the merge?', options: [{ id: 'yes', label: 'Yes' }] }
		});

		const { questionId } = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
			...caller,
			question: 'Ship the merge?',
			options: [{ id: 'yes', label: 'Yes' }]
		});

		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: caller.runId,
			expectedClaimId: caller.claimId,
			executionSecret: caller.executionSecret,
			status: 'completed',
			text: 'waiting'
		});

		const afterFinalize = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(afterFinalize?.archivedAt).toBeUndefined();
		expect(afterFinalize?.settleWhenIdle).toBe(true);

		const answered = await asUser.mutation(api.agentQuestions.answer, {
			threadId,
			questionId,
			optionId: 'yes'
		});

		const continuation = answered.continuation;
		expect(continuation?.runId).toBe(caller.runId);

		if (!continuation) {
			throw new Error('Expected a question continuation.');
		}

		const afterAnswer = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(afterAnswer?.archivedAt).toBeTypeOf('number');
		expect(afterAnswer?.settleWhenIdle).toBeUndefined();

		const continued = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'question-continuation',
			executionSecret: 'continuation-secret',
			prompt: continuation.prompt,
			continuationOfRunId: continuation.runId
		});

		const afterContinue = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(afterContinue?.archivedAt).toBeUndefined();
		expect(afterContinue?.settleWhenIdle).toBe(true);

		await t.mutation(api.agentRuntime.start, {
			runId: continued.runId,
			claimId: 'continuation-claim',
			executionSecret: 'continuation-secret'
		});

		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: continued.runId,
			expectedClaimId: 'continuation-claim',
			executionSecret: 'continuation-secret',
			status: 'completed',
			text: 'done'
		});

		const settled = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(settled?.archivedAt).toBeTypeOf('number');
		expect(settled?.settleWhenIdle).toBeUndefined();
	});

	it('does not archive an abandoned run that is still eligible for recovery', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const machineId = 'settle-recovery-machine';

		await asUser.mutation(api.machines.registerProcess, {
			machineId,
			processId: 'settle-process',
			friendlyName: 'Workstation',
			platform: 'linux',
			platformVersion: 'test',
			architecture: 'x86_64',
			hostname: 'workstation',
			appVersion: 'test'
		});

		const created = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'interrupted-pr-run',
			executionSecret: 'pr-secret',
			prompt: 'Open the PR',
			machineId
		});

		const caller = { runId: created.runId, claimId: 'pr-claim', executionSecret: 'pr-secret' };

		await t.mutation(api.agentRuntime.start, caller);
		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(1, 'merged')]
		});

		await abandonRun(t, created.runId);

		const abandoned = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(abandoned?.archivedAt).toBeUndefined();
		expect(abandoned?.settleWhenIdle).toBe(true);
		expect(
			await asUser.query(api.runRecovery.state, {
				submissionId: 'interrupted-pr-run',
				machineId
			})
		).toMatchObject({ state: 'recover' });

		const recovered = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: `${AUTOMATIC_RECOVERY_SUBMISSION_PREFIX}next`,
			executionSecret: 'next-secret',
			prompt: '',
			machineId,
			continuationOfRunId: created.runId
		});

		expect(recovered.runId).not.toBe(created.runId);
		expect(
			(await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.archivedAt
		).toBeUndefined();
	});

	it('settles after the automatic recovery wait expires', async () => {
		vi.useFakeTimers();

		try {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const machineId = 'settle-recovery-timeout-machine';

			await asUser.mutation(api.machines.registerProcess, {
				machineId,
				processId: 'settle-timeout-process',
				friendlyName: 'Workstation',
				platform: 'linux',
				platformVersion: 'test',
				architecture: 'x86_64',
				hostname: 'workstation',
				appVersion: 'test'
			});

			const created = await insertQueuedRun(t, asUser, {
				threadId,
				submissionId: 'interrupted-timeout-pr-run',
				executionSecret: 'pr-secret',
				prompt: 'Open the PR',
				machineId
			});

			const caller = { runId: created.runId, claimId: 'pr-claim', executionSecret: 'pr-secret' };

			await t.mutation(api.agentRuntime.start, caller);
			await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
			await t.mutation(api.pullRequests.link, {
				...caller,
				pullRequests: [pr(1, 'merged')]
			});

			await abandonRun(t, created.runId);

			const abandoned = await t.run((ctx) => ctx.db.get('threadRecords', threadId));

			expect(abandoned?.archivedAt).toBeUndefined();
			expect(abandoned?.settleWhenIdle).toBe(true);

			await vi.advanceTimersByTimeAsync(AUTOMATIC_RECOVERY_GRACE_MS);
			await t.finishInProgressScheduledFunctions();

			const settled = await t.run((ctx) => ctx.db.get('threadRecords', threadId));

			expect(settled?.archivedAt).toBeTypeOf('number');
			expect(settled?.settleWhenIdle).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps a pending settle when a new run abandons an expired claim', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await asUser.mutation(api.uiPreferences.setAutomaticAgentContinuation, { enabled: false });
		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.mutation(api.pullRequests.link, {
			...caller,
			pullRequests: [pr(1, 'merged')]
		});
		await t.run((ctx) => patchRunExecution(ctx, caller.runId, { claimExpiresAt: Date.now() - 1 }));

		const continued = await createQueuedRun(t, asUser, threadId, 'follow-up', 'follow-up-secret');
		const pending = await t.run((ctx) => ctx.db.get('threadRecords', threadId));

		expect(pending?.archivedAt).toBeUndefined();
		expect(pending?.settleWhenIdle).toBe(true);

		await t.mutation(api.agentRuntime.start, {
			runId: continued.runId,
			claimId: 'follow-up-claim',
			executionSecret: 'follow-up-secret'
		});
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: continued.runId,
			expectedClaimId: 'follow-up-claim',
			executionSecret: 'follow-up-secret',
			status: 'completed',
			text: 'done'
		});

		const settled = await t.run((ctx) => ctx.db.get('threadRecords', threadId));

		expect(settled?.archivedAt).toBeTypeOf('number');
		expect(settled?.settleWhenIdle).toBeUndefined();
	});

	it('drops a pending settle as soon as the setting is turned off', async () => {
		const t = initConvexTest();
		const { asUser, threadId, caller } = await startRun(t);

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.run((ctx) =>
			ctx.db.patch('threadRecords', threadId, { pullRequests: [pr(1, 'open')] })
		);
		await asUser.mutation(api.pullRequests.updateStates, {
			updates: [{ threadId, ...pr(1, 'merged') }]
		});
		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: false });

		const disabled = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(disabled?.archivedAt).toBeUndefined();
		expect(disabled?.settleWhenIdle).toBeUndefined();

		await asUser.mutation(api.uiPreferences.setSettleMergedThreads, { enabled: true });
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: caller.runId,
			expectedClaimId: caller.claimId,
			executionSecret: caller.executionSecret,
			status: 'completed',
			text: 'done'
		});

		const thread = await t.run((ctx) => ctx.db.get('threadRecords', threadId));
		expect(thread?.archivedAt).toBeUndefined();
		expect(thread?.settleWhenIdle).toBeUndefined();
	});
});
