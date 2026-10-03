import { describe, expect, it, vi } from 'vitest';

import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { AGENT_DECIDE_OPTION_ID, QUESTION_TIMEOUT_CHECKPOINT_MS } from '@convex/lib/agentQuestions';
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	toolTranscriptAssignment
} from '@convex/test.setup';

async function startRun(
	t: ReturnType<typeof initConvexTest>,
	threadId: Id<'threadRecords'>,
	timeoutMs?: number | null
) {
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
		...toolTranscriptAssignment(created.runId, claimId),
		kind: 'ask_question',
		payload: {
			question: 'placeholder',
			options: [{ id: 'a', label: 'A' }],
			timeoutMs
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

		expect(first.timeoutAt).toBeGreaterThan(Date.now());

		const second = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Second question?',
			options: [{ id: 'alpha', label: 'Alpha' }],
			timeoutMs: 60_000,
			executionSecret
		});

		const head = await asUser.query(api.agentQuestions.headPendingForThread, {
			threadId
		});

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
			question: {
				status: 'answered',
				answer: {
					optionId: 'two',
					optionLabel: 'Two',
					text: 'with detail'
				}
			}
		});

		expect(
			(
				await asUser.query(api.agentQuestions.headPendingForThread, {
					threadId
				})
			)?.questionId
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
		expect(timedSnapshot?.answeredAt).toBeTypeOf('number');

		vi.useRealTimers();
	});

	describe('createWithOptionalExpiry', () => {
		it.each([
			['omitted', {}],
			['null', { timeoutMs: null }]
		] as const)('creates a question with no expiry when timeoutMs is %s', async (_label, extra) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');

			const { executionSecret, claimId, runId } = await startRun(
				t,
				threadId,
				'timeoutMs' in extra ? extra.timeoutMs : undefined
			);

			const created = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
				runId,
				claimId,
				question: 'No expiry?',
				options: [{ id: 'yes', label: 'Yes' }],
				...extra,
				executionSecret
			});

			expect(created).not.toHaveProperty('timeoutAt');

			const snapshot = await t.query(api.agentQuestions.getForExecutor, {
				runId,
				questionId: created.questionId,
				executionSecret
			});

			expect(snapshot?.status).toBe('pending');
			expect(snapshot).not.toHaveProperty('timeoutAt');

			await t.mutation(internal.agentQuestions.timeout, { questionId: created.questionId });

			expect((await t.run((ctx) => ctx.db.get('agentQuestions', created.questionId)))?.status).toBe(
				'pending'
			);

			await expect(
				asUser.mutation(api.agentQuestions.answer, {
					threadId,
					questionId: created.questionId,
					optionId: 'yes'
				})
			).resolves.toMatchObject({ question: { status: 'answered' } });
		});

		it('creates an already timed-out question atomically when timeoutMs is zero', async () => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
			const { executionSecret, claimId, runId } = await startRun(t, threadId);

			const created = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
				runId,
				claimId,
				question: 'Too late?',
				options: [{ id: 'yes', label: 'Yes' }],
				timeoutMs: 0,
				executionSecret
			});

			expect(created.timeoutAt).toBeTypeOf('number');

			const snapshot = await t.query(api.agentQuestions.getForExecutor, {
				runId,
				questionId: created.questionId,
				executionSecret
			});

			expect(snapshot?.status).toBe('timedOut');
			expect(snapshot?.answeredAt).toBe(snapshot?.createdAt);

			expect(await asUser.query(api.agentQuestions.headPendingForThread, { threadId })).toBeNull();

			await expect(
				asUser.mutation(api.agentQuestions.answer, {
					threadId,
					questionId: created.questionId,
					optionId: 'yes'
				})
			).rejects.toThrow(/no longer awaiting an answer/);
		});

		it('honors a sub-second lifetime without flooring it', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
			const { executionSecret, claimId, runId } = await startRun(t, threadId);

			const created = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
				runId,
				claimId,
				question: 'Quick question?',
				options: [{ id: 'yes', label: 'Yes' }],
				timeoutMs: 250,
				executionSecret
			});

			expect(created.timeoutAt).toBe(Date.now() + 250);

			vi.setSystemTime(new Date('2026-08-01T10:00:00.300Z'));

			await expect(
				asUser.mutation(api.agentQuestions.answer, {
					threadId,
					questionId: created.questionId,
					optionId: 'yes'
				})
			).resolves.toMatchObject({ question: { status: 'answered' } });

			vi.useRealTimers();
		});

		it('honors a beyond-24h lifetime without capping it', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
			const { executionSecret, claimId, runId } = await startRun(t, threadId);

			const timeoutMs = 48 * 60 * 60 * 1000;

			const created = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
				runId,
				claimId,
				question: 'Slow question?',
				options: [{ id: 'yes', label: 'Yes' }],
				timeoutMs,
				executionSecret
			});

			expect(created.timeoutAt).toBe(Date.now() + timeoutMs);

			vi.setSystemTime(new Date('2026-08-02T11:00:00.000Z'));

			await expect(
				asUser.mutation(api.agentQuestions.answer, {
					threadId,
					questionId: created.questionId,
					optionId: 'yes'
				})
			).resolves.toMatchObject({ question: { status: 'answered' } });

			vi.useRealTimers();
		});

		it('rejects non-integer, negative, and non-finite lifetimes', async () => {
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t, 'user_alice');
			const { executionSecret, claimId, runId } = await startRun(t, threadId);

			for (const timeoutMs of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
				await expect(
					t.mutation(api.agentQuestions.createWithOptionalExpiry, {
						runId,
						claimId,
						question: 'Bad timeout?',
						options: [{ id: 'yes', label: 'Yes' }],
						timeoutMs,
						executionSecret
					})
				).rejects.toThrow(/non-negative integer/);
			}
		});

		it('checkpoints distant deadlines without expiring early', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
			const { executionSecret, claimId, runId } = await startRun(t, threadId);

			const timeoutMs = 400 * 24 * 60 * 60 * 1000;

			const created = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
				runId,
				claimId,
				question: 'Far-future question?',
				options: [{ id: 'yes', label: 'Yes' }],
				timeoutMs,
				executionSecret
			});

			expect(created.timeoutAt).toBe(Date.now() + timeoutMs);

			const deadline = new Date('2026-08-01T10:00:00.000Z').getTime() + timeoutMs;
			let now = Date.now();

			while (deadline - now > QUESTION_TIMEOUT_CHECKPOINT_MS) {
				now += QUESTION_TIMEOUT_CHECKPOINT_MS;
				vi.setSystemTime(now);

				await t.mutation(internal.agentQuestions.timeout, { questionId: created.questionId });

				expect(
					(await t.run((ctx) => ctx.db.get('agentQuestions', created.questionId)))?.status
				).toBe('pending');
			}

			vi.setSystemTime(deadline - 1);
			await t.mutation(internal.agentQuestions.timeout, { questionId: created.questionId });

			expect((await t.run((ctx) => ctx.db.get('agentQuestions', created.questionId)))?.status).toBe(
				'pending'
			);

			await expect(
				asUser.mutation(api.agentQuestions.answer, {
					threadId,
					questionId: created.questionId,
					optionId: 'yes'
				})
			).resolves.toMatchObject({ question: { status: 'answered' } });

			vi.useRealTimers();
		});

		it('expires a checkpointed question once the deadline passes', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t, 'user_alice');
			const { executionSecret, claimId, runId } = await startRun(t, threadId);

			const timeoutMs = 400 * 24 * 60 * 60 * 1000;

			const created = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
				runId,
				claimId,
				question: 'Far-future question?',
				options: [{ id: 'yes', label: 'Yes' }],
				timeoutMs,
				executionSecret
			});

			const deadline = Date.now() + timeoutMs;

			vi.setSystemTime(deadline - 1);
			await t.mutation(internal.agentQuestions.timeout, { questionId: created.questionId });
			expect((await t.run((ctx) => ctx.db.get('agentQuestions', created.questionId)))?.status).toBe(
				'pending'
			);

			vi.setSystemTime(deadline);
			await t.mutation(internal.agentQuestions.timeout, { questionId: created.questionId });
			expect((await t.run((ctx) => ctx.db.get('agentQuestions', created.questionId)))?.status).toBe(
				'timedOut'
			);

			vi.useRealTimers();
		});
		it('accepts a lifetime beyond the JavaScript date range', async () => {
			vi.useFakeTimers();
			const t = initConvexTest();
			const { threadId } = await seedOwnedThread(t, 'user_alice');
			const { executionSecret, claimId, runId } = await startRun(t, threadId);
			const timeoutMs = 2 ** 64;

			const created = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
				runId,
				claimId,
				question: 'Long-lived question?',
				options: [{ id: 'yes', label: 'Yes' }],
				timeoutMs,
				executionSecret
			});

			expect(created.timeoutAt).toBeGreaterThanOrEqual(timeoutMs);
			await t.mutation(internal.agentQuestions.timeout, { questionId: created.questionId });
			expect(
				await t.query(api.agentQuestions.getForExecutor, {
					runId,
					questionId: created.questionId,
					executionSecret
				})
			).toMatchObject({ status: 'pending', timeoutAt: created.timeoutAt });
			vi.useRealTimers();
		});
	});

	it('keeps the legacy default deadline of 30 minutes on create', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t, 'user_alice');
		const { executionSecret, claimId, runId } = await startRun(t, threadId);

		const created = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Default expiry?',
			options: [{ id: 'yes', label: 'Yes' }],
			executionSecret
		});

		expect(created.timeoutAt).toBe(Date.now() + 30 * 60 * 1000);

		vi.setSystemTime(Date.now() + 30 * 60 * 1000);
		await t.mutation(internal.agentQuestions.timeout, { questionId: created.questionId });

		expect((await t.run((ctx) => ctx.db.get('agentQuestions', created.questionId)))?.status).toBe(
			'timedOut'
		);

		vi.useRealTimers();
	});

	it('serves repeated executor reads of an answered question durably', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-01T10:00:00.000Z'));
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const { executionSecret, claimId, runId } = await startRun(t, threadId);

		const created = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Durable answer?',
			options: [{ id: 'yes', label: 'Yes' }],
			timeoutMs: 60_000,
			executionSecret
		});

		await asUser.mutation(api.agentQuestions.answer, {
			threadId,
			questionId: created.questionId,
			optionId: 'yes',
			text: 'stored once'
		});

		let previous: unknown;

		for (let read = 0; read < 3; read += 1) {
			const snapshot = await t.query(api.agentQuestions.getForExecutor, {
				runId,
				questionId: created.questionId,
				executionSecret
			});

			expect(snapshot).toMatchObject({
				status: 'answered',
				answer: { optionId: 'yes', optionLabel: 'Yes', text: 'stored once' }
			});
			expect(snapshot?.answeredAt).toBeTypeOf('number');

			if (previous !== undefined) expect(snapshot).toEqual(previous);
			previous = snapshot;
		}

		await t.mutation(internal.agentQuestions.timeout, { questionId: created.questionId });

		expect((await t.run((ctx) => ctx.db.get('agentQuestions', created.questionId)))?.status).toBe(
			'answered'
		);

		vi.useRealTimers();
	});

	it('cancels no-expiry questions when the run is cancelled', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const { executionSecret, claimId, runId } = await startRun(t, threadId);

		const created = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
			runId,
			claimId,
			question: 'Still open?',
			options: [{ id: 'yes', label: 'Yes' }],
			executionSecret
		});

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			text: '',
			status: 'cancelled',
			executionSecret
		});

		const snapshot = await t.query(api.agentQuestions.getForExecutor, {
			runId,
			questionId: created.questionId,
			executionSecret
		});

		expect(snapshot?.status).toBe('cancelled');
	});

	it('uses the answer as the continuation prompt for one terminal question', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const { executionSecret, claimId, runId } = await startRun(t, threadId);

		const question = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Which database?',
			options: [{ id: 'postgres', label: 'PostgreSQL' }],
			executionSecret
		});

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			text: '',
			status: 'failed',
			lastError: 'Stopped before receiving the answer.',
			executionSecret
		});

		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId: question.questionId,
				optionId: 'postgres',
				text: 'Use the existing container'
			})
		).resolves.toMatchObject({
			continuation: {
				runId,
				prompt: 'PostgreSQL: Use the existing container'
			}
		});
	});

	it('does not repeat answers consumed before the run finished', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const { executionSecret, claimId, runId } = await startRun(t, threadId);

		const consumed = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Which database?',
			options: [{ id: 'postgres', label: 'PostgreSQL' }],
			executionSecret
		});

		await asUser.mutation(api.agentQuestions.answer, {
			threadId,
			questionId: consumed.questionId,
			optionId: 'postgres'
		});

		const pending = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Where should I deploy it?',
			options: [{ id: 'fly', label: 'Fly.io' }],
			executionSecret
		});

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			text: '',
			status: 'completed',
			executionSecret
		});

		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId: pending.questionId,
				optionId: 'fly'
			})
		).resolves.toMatchObject({
			continuation: {
				runId,
				prompt: 'Fly.io'
			}
		});
	});

	it('keeps pending questions after completion and aggregates their answers', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t, 'user_alice');
		const { executionSecret, claimId, runId } = await startRun(t, threadId);

		const first = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'First open question?',
			options: [{ id: 'yes', label: 'Yes' }],
			executionSecret
		});

		const second = await t.mutation(api.agentQuestions.create, {
			runId,
			claimId,
			question: 'Second open question?',
			options: [{ id: 'ship', label: 'Ship it' }],
			executionSecret
		});

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			text: '',
			status: 'completed',
			executionSecret
		});

		await expect(
			asUser.query(api.agentQuestions.headPendingForThread, { threadId })
		).resolves.toMatchObject({
			questionId: first.questionId,
			status: 'pending'
		});

		const firstAnswer = await asUser.mutation(api.agentQuestions.answer, {
			threadId,
			questionId: first.questionId,
			optionId: 'yes'
		});

		expect(firstAnswer).toMatchObject({
			question: {
				status: 'answered',
				answer: { optionId: 'yes', optionLabel: 'Yes' }
			}
		});
		expect(firstAnswer).not.toHaveProperty('continuation');
		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId: second.questionId,
				optionId: 'ship',
				text: 'include the release notes'
			})
		).resolves.toMatchObject({
			question: {
				status: 'answered',
				answer: {
					optionId: 'ship',
					optionLabel: 'Ship it',
					text: 'include the release notes'
				}
			},
			continuation: {
				runId,
				prompt:
					'Answers to your questions:\n\n1. First open question?\n   Yes\n\n2. Second open question?\n   Ship it: include the release notes'
			}
		});
	});

	it('keeps a pending head answerable until its timeout mutation runs', async () => {
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
		).toBe(overdue.questionId);

		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId: overdue.questionId,
				optionId: 'old'
			})
		).resolves.toMatchObject({
			question: {
				status: 'answered',
				answer: { optionId: 'old', optionLabel: 'Old' }
			}
		});

		expect(
			(await asUser.query(api.agentQuestions.headPendingForThread, { threadId }))?.questionId
		).toBe(next.questionId);

		await expect(
			asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId: next.questionId,
				optionId: 'new'
			})
		).resolves.toMatchObject({
			question: {
				status: 'answered',
				answer: { optionId: 'new', optionLabel: 'New' }
			}
		});
		vi.useRealTimers();
	});
});
