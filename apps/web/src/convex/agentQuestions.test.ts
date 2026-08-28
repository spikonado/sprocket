import { describe, expect, it, vi } from 'vitest';

import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { AGENT_DECIDE_OPTION_ID } from '@convex/lib/agentQuestions';
import { createQueuedRun, initConvexTest, seedOwnedThread } from '@convex/test.setup';

async function startRun(t: ReturnType<typeof initConvexTest>, threadId: Id<'threadRecords'>) {
	const asUser = t.withIdentity({ subject: 'user_alice' });
	const executionSecret = 'question-secret';
	const created = await createQueuedRun(
		t,
		asUser,
		threadId,
		`sub-question-${Math.random()}`,
		executionSecret,
		'Need a choice'
	);
	const claimId = 'claim-question';
	await t.mutation(api.agentRuntime.start, {
		runId: created.runId,
		claimId,
		executionSecret
	});
	await t.mutation(api.agentRuntime.beginToolJob, {
		runId: created.runId,
		claimId,
		kind: 'ask_question',
		payload: {
			question: 'placeholder',
			options: [{ id: 'a', label: 'A' }]
		},
		executionSecret
	});
	return { asUser, executionSecret, claimId, runId: created.runId };
}

describe('agentQuestions', () => {
	it('creates a question with agent_decide, enforces FIFO answers, and times out', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const { executionSecret, claimId, runId } = await startRun(t, threadId);

		await expect(
			t.mutation(api.agentQuestions.create, {
				runId,
				claimId,
				question: 'x'.repeat(2001),
				options: [{ id: 'a', label: 'A' }],
				executionSecret
			})
		).rejects.toThrow(/2000/);

		const first = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'First question?',
			options: [
				{ id: 'one', label: 'One' },
				{ id: 'two', label: 'Two' }
			],
			timeoutMs: 5_000,
			executionSecret
		});
		expect(first.options.map((option) => option.id)).toEqual([
			'one',
			'two',
			AGENT_DECIDE_OPTION_ID
		]);

		const second = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Second question?',
			options: [{ id: 'alpha', label: 'Alpha' }],
			timeoutMs: 60_000,
			executionSecret
		});

		const head = await asUser.query(api.agentQuestions.headPendingForThread, { threadId });
		expect(head?.questionId).toBe(first.questionId);

		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId: second.questionId,
				optionId: 'alpha'
			})
		).rejects.toThrow(/earliest pending/);

		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId: first.questionId,
				optionId: 'two',
				text: 'with detail'
			})
		).resolves.toMatchObject({
			status: 'answered',
			answer: {
				optionId: 'two',
				optionLabel: 'Two',
				text: 'with detail'
			}
		});

		expect(
			(await asUser.query(api.agentQuestions.headPendingForThread, { threadId }))?.questionId
		).toBe(second.questionId);

		const timed = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Will time out?',
			options: [{ id: 'x', label: 'X' }],
			timeoutMs: 1_000,
			executionSecret
		});

		await asUser.mutation(api.agentQuestions.answer, {
			threadId,
			questionId: second.questionId,
			text: 'custom only'
		});

		await t.finishAllScheduledFunctions(() => {
			vi.advanceTimersByTime(2_000);
		});

		const timedSnapshot = await t.query(api.agentQuestions.getForExecutor, {
			runId,
			questionId: timed.questionId,
			executionSecret
		});
		expect(timedSnapshot?.status).toBe('timedOut');

		vi.useRealTimers();
	});

	it('cancels pending questions when the run finalizes', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const { executionSecret, claimId, runId } = await startRun(t, threadId);

		const created = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Still open?',
			options: [{ id: 'yes', label: 'Yes' }],
			executionSecret
		});

		await asUser.mutation(api.agentRuntime.finalizeRun, {
			runId,
			text: '',
			status: 'cancelled'
		});

		const snapshot = await t.query(api.agentQuestions.getForExecutor, {
			runId,
			questionId: created.questionId,
			executionSecret
		});
		expect(snapshot?.status).toBe('cancelled');
	});

	it('expires overdue heads on answer so FIFO can advance before the scheduler', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const { executionSecret, claimId, runId } = await startRun(t, threadId);

		const overdue = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Overdue?',
			options: [{ id: 'old', label: 'Old' }],
			timeoutMs: 1_000,
			executionSecret
		});
		const next = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Still live?',
			options: [{ id: 'new', label: 'New' }],
			timeoutMs: 60_000,
			executionSecret
		});

		vi.setSystemTime(new Date('2026-07-26T12:00:02.000Z'));

		expect(
			(await asUser.query(api.agentQuestions.headPendingForThread, { threadId }))?.questionId
		).toBe(next.questionId);

		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId: overdue.questionId,
				optionId: 'old'
			})
		).rejects.toThrow(/no longer awaiting/);

		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId: next.questionId,
				optionId: 'new'
			})
		).resolves.toMatchObject({
			status: 'answered',
			answer: { optionId: 'new', optionLabel: 'New' }
		});

		const overdueSnapshot = await t.query(api.agentQuestions.getForExecutor, {
			runId,
			questionId: overdue.questionId,
			executionSecret
		});
		expect(overdueSnapshot?.status).toBe('timedOut');

		vi.useRealTimers();
	});
});
