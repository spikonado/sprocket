import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { executionSecretHash } from '@convex/lib/auth';
import { recordToolTranscript } from '@convex/lib/transcriptWrites';
import { toolInvocationIdForJob, toolSourceKey } from '@convex/lib/transcriptParts';
import {
	createQueuedRun,
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	seedThreadRecord,
	type ConvexTestInstance
} from './test.setup';

beforeEach(() => vi.useFakeTimers());

afterEach(() => vi.useRealTimers());

async function seedJobs(
	t: ConvexTestInstance,
	runId: Id<'runs'>,
	count: number,
	largeOutput: boolean
) {
	const jobs: Doc<'executorJobs'>[] = [];

	for (let index = 0; index < count; index++) {
		jobs.push(
			await t.run(async (ctx) => {
				const run = (await ctx.db.get('runs', runId))!;
				const settled = index % 3 !== 0;

				const jobId = await ctx.db.insert('executorJobs', {
					threadId: run.threadId,
					runId,
					kind: 'exec_command',
					payload: { cmd: 'true' },
					status: settled ? 'completed' : 'claimed',
					enqueuedAt: 1,
					completedAt: settled ? 2 : undefined,
					result: settled
						? {
								output: largeOutput ? 'x'.repeat(950_000) : `output-${index}`,
								exitCode: 0,
								success: true,
								running: false,
								timedOut: false,
								completeLogPath: '/output.log',
								eventsPath: '/events.jsonl'
							}
						: undefined,
					sequence: index * 3,
					toolInvocationId: index % 2 === 0 ? `${runId}:${index}` : undefined,
					sectionKey: `section:${runId}:${index}`,
					sectionOrdinal: index
				});

				const job = (await ctx.db.get('executorJobs', jobId))!;

				if (settled && index % 2 === 0) {
					await recordToolTranscript(ctx, {
						threadId: run.threadId,
						userId: run.userId,
						runId,
						job
					});
				}

				return job;
			})
		);
	}

	return jobs;
}

async function expectCleanedJobs(t: ConvexTestInstance, jobs: Doc<'executorJobs'>[]) {
	for (const job of jobs) {
		await t.run(async (ctx) => {
			const persisted = await ctx.db.get('executorJobs', job._id);
			expect(persisted?.status).toBe(job.status === 'claimed' ? 'cancelled' : job.status);
			expect(persisted?.result).toEqual(job.result);

			const part = await ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_sourceKey', (q) =>
					q
						.eq('threadId', job.threadId)
						.eq('sourceKey', toolSourceKey(toolInvocationIdForJob(job), 'finished'))
				)
				.unique();

			expect(part?.tool).toMatchObject({
				toolInvocationId: toolInvocationIdForJob(job),
				status: persisted?.status
			});
		});
	}
}

describe('bounded terminal cleanup', { timeout: 30_000 }, () => {
	it('force-cancels a large history and resumes transcript retries in fresh transactions', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'large-run', 'secret');
		const jobs = await seedJobs(t, runId, 35, true);
		await t.run((ctx) =>
			ctx.db.patch('runs', runId, {
				cancellationRequestedAt: Date.now() - 100,
				cancellationDeadlineAt: Date.now() - 1
			})
		);

		expect(await t.mutation(internal.runLifecycle.forceCancelRun, { runId })).toBe(true);
		const run = await t.run((ctx) => ctx.db.get('runs', runId));
		expect(run?.status).toBe('cancelled');
		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBeLessThan(
			jobs.length + 1
		);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await expectCleanedJobs(t, jobs);
		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(
			jobs.length + 1
		);

		await t.mutation(internal.runCleanup.continueCleanup, {
			runId,
			completedAt: run!.completedAt!,
			jobCursor: -1,
			questionCursor: -1
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await asUser.query(api.transcript.getState, { threadId })).totalParts).toBe(
			jobs.length + 1
		);
	});

	it('registers a replacement machine atomically even when its runs have large histories', async () => {
		const t = initConvexTest();
		const { asUser, subject } = await seedOwnedThread(t);

		const machine = {
			machineId: 'large-machine',
			friendlyName: 'Workshop',
			platform: 'linux',
			platformVersion: '6.12',
			architecture: 'x86_64',
			hostname: 'workbench',
			appVersion: '0.3.2'
		};

		await asUser.mutation(api.machines.tryRegister, {
			...machine,
			credentialHash: await executionSecretHash('old-process')
		});
		const runIds: Id<'runs'>[] = [];
		const jobs: Doc<'executorJobs'>[] = [];

		for (let index = 0; index < 3; index++) {
			const threadId = await seedThreadRecord(t, subject, 'alpha');

			const { runId } = await insertQueuedRun(t, asUser, {
				threadId,
				submissionId: `machine-run-${index}`,
				executionSecret: `secret-${index}`,
				prompt: 'Work',
				machineId: machine.machineId
			});

			runIds.push(runId);
			jobs.push(...(await seedJobs(t, runId, 17, true)));
		}

		vi.setSystemTime(Date.now() + 90_001);
		expect(
			await asUser.mutation(api.machines.tryRegister, {
				...machine,
				credentialHash: await executionSecretHash('new-process')
			})
		).toMatchObject({ status: 'registered' });

		for (const runId of runIds) {
			expect(await t.run((ctx) => ctx.db.get('runs', runId))).toMatchObject({
				status: 'failed',
				lastError: 'The machine stopped before this run finished.'
			});
		}

		expect(await t.run((ctx) => ctx.db.query('machines').unique())).toMatchObject({
			runIds: [],
			credentialHash: await executionSecretHash('new-process')
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await expectCleanedJobs(t, jobs);
	});

	it('preserves answers submitted before deferred question cleanup runs', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'early-answer-run', 'secret');
		const [job] = await seedJobs(t, runId, 1, false);

		const questionIds = await t.run(async (ctx) => {
			const ids: Id<'agentQuestions'>[] = [];

			for (let index = 0; index < 35; index++) {
				ids.push(
					await ctx.db.insert('agentQuestions', {
						threadId,
						runId,
						jobId: job._id,
						question: `Question ${index}?`,
						options: [{ id: 'yes', label: `Answer ${index}` }],
						status: 'pending',
						createdAt: 1,
						timeoutAt: Date.now() + 60_000,
						sequence: index
					})
				);
			}

			return ids;
		});

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'secret',
			text: '',
			status: 'failed'
		});

		for (const questionId of questionIds.slice(0, -1)) {
			await asUser.mutation(api.agentQuestions.answer, {
				threadId,
				questionId,
				optionId: 'yes'
			});
		}

		const result = await asUser.mutation(api.agentQuestions.answer, {
			threadId,
			questionId: questionIds.at(-1)!,
			optionId: 'yes'
		});

		expect(result.continuation).toMatchObject({
			runId,
			prompt: expect.stringContaining('Answer 34')
		});

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const questions = await t.run((ctx) => ctx.db.query('agentQuestions').collect());

		for (const question of questions) {
			expect(question).toMatchObject({ status: 'answered', requiresContinuation: true });
		}
	});

	it.each(['cancelled', 'failed', 'completed'] as const)(
		'finishes questions across pages before recording %s job transcripts',
		async (status) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const { runId } = await createQueuedRun(t, asUser, threadId, 'questions-run', 'secret');
			const jobs = await seedJobs(t, runId, 35, false);
			await t.run(async (ctx) => {
				for (const job of jobs) {
					await ctx.db.insert('agentQuestions', {
						threadId,
						runId,
						jobId: job._id,
						question: 'Continue?',
						options: [{ id: 'yes', label: 'Yes' }],
						status: 'pending',
						createdAt: 1,
						timeoutAt: Date.now() + 60_000,
						sequence: job.sequence
					});
				}
			});
			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId,
				executionSecret: 'secret',
				text: '',
				status
			});

			if (status === 'cancelled') {
				const highestSequence = Math.max(...jobs.map((job) => job.sequence));

				const deferredQuestion = await t.run((ctx) =>
					ctx.db
						.query('agentQuestions')
						.withIndex('by_runId_sequence', (q) => q.eq('runId', runId))
						.order('desc')
						.first()
				);

				expect(deferredQuestion?.sequence).toBe(highestSequence);
				await expect(
					asUser.mutation(api.agentQuestions.answer, {
						threadId,
						questionId: deferredQuestion!._id,
						optionId: 'yes'
					})
				).rejects.toThrow('Question is no longer awaiting an answer.');
			}

			await t.finishAllScheduledFunctions(vi.runAllTimers);
			const questions = await t.run((ctx) => ctx.db.query('agentQuestions').collect());
			expect(questions).toHaveLength(jobs.length);

			for (const question of questions) {
				expect(question).toMatchObject(
					status === 'cancelled'
						? { status: 'cancelled', answeredAt: expect.any(Number) }
						: { status: 'pending', requiresContinuation: true }
				);
			}

			await expectCleanedJobs(t, jobs);
		}
	);
});
