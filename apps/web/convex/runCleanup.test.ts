import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { executionSecretHash } from '@convex/lib/auth';
import { actionablePendingQuestionsForThread } from '@convex/lib/agentQuestions';
import { registerChildThread, subtreeSummary } from '@convex/lib/threadHierarchy';
import { recordToolTranscript } from '@convex/lib/transcriptWrites';
import { toolInvocationIdForJob, toolSourceKey } from '@convex/lib/transcriptParts';
import { getRunExecutionState, patchRunExecution } from '@convex/lib/runExecution';
import { RUN_QUEUED_STARTUP_DEADLINE_MS } from '@convex/lib/runLease';
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

async function finishImmediateCleanup(t: ConvexTestInstance) {
	for (let iteration = 0; iteration < 1000; iteration++) {
		const pending = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());

		if (
			!pending.some((entry) => entry.state.kind === 'pending' && entry.scheduledTime <= Date.now())
		)
			return;
		await vi.advanceTimersByTimeAsync(1);
		await t.finishInProgressScheduledFunctions();
	}

	throw new Error('Immediate cleanup did not settle.');
}

async function transcriptParts(t: ConvexTestInstance, threadId: Id<'threadRecords'>) {
	const parts: Doc<'threadTranscriptParts'>[] = [];
	let afterNumber = -1;

	for (;;) {
		const page = await t.run((ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (q) =>
					q.eq('threadId', threadId).gt('number', afterNumber)
				)
				.take(5)
		);

		parts.push(...page);

		if (page.length === 0) return parts;
		afterNumber = page.at(-1)!.number;
	}
}

describe('bounded terminal cleanup', { timeout: 30_000 }, () => {
	it.each(['failed', 'cancelled', 'completed'] as const)(
		'rejects a follow-up after %s without storing it until prior tool outcomes are committed',
		async (status) => {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);
			const { runId } = await createQueuedRun(t, asUser, threadId, 'prior-run', 'prior-secret');
			const jobs = await seedJobs(t, runId, 35, true);
			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId,
				executionSecret: 'prior-secret',
				text: '',
				status
			});

			const submit = () =>
				createQueuedRun(
					t,
					asUser,
					threadId,
					'follow-up',
					'follow-up-secret',
					'Use the prior results'
				);

			expect(await asUser.mutation(api.agentRuntime.prepareSubmission, { threadId })).toBe(false);
			await expect(submit()).rejects.toThrow('SPROCKET_SUBMISSION_WAITING');
			expect(
				(await transcriptParts(t, threadId)).filter((part) => part.kind === 'prompt')
			).toHaveLength(1);
			expect(
				await t.run((ctx) =>
					ctx.db
						.query('runs')
						.withIndex('by_userId_submissionId', (q) =>
							q.eq('userId', 'user_alice').eq('submissionId', 'follow-up')
						)
						.unique()
				)
			).toBeNull();

			await finishImmediateCleanup(t);

			expect(await asUser.mutation(api.agentRuntime.prepareSubmission, { threadId })).toBe(true);

			const next = await submit();
			expect(next.created).toBe(true);
			expect(await submit()).toMatchObject({ created: false, runId: next.runId });
			const auth = { runId: next.runId, executionSecret: 'follow-up-secret' };
			expect(
				await asUser.mutation(api.agentRuntime.start, { ...auth, claimId: 'next-claim' })
			).toMatchObject({ claimed: true });
			expect(await t.query(api.agentRuntime.getContext, auth)).toMatchObject({
				prompt: 'Use the prior results'
			});
			const parts = await transcriptParts(t, threadId);
			const prompt = parts.find((part) => part.runId === next.runId && part.kind === 'prompt');
			expect(prompt?.prompt?.text).toBe('Use the prior results');

			for (const job of jobs) {
				const outcome = parts.find(
					(part) => part.sourceKey === toolSourceKey(toolInvocationIdForJob(job), 'finished')
				);

				expect(outcome?.number).toBeLessThan(prompt!.number);
			}
		}
	);

	it('keeps a cancelled message committed ahead of its replacement', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'prior-run', 'prior-secret');
		await seedJobs(t, runId, 35, false);
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'prior-secret',
			text: '',
			status: 'cancelled'
		});

		await finishImmediateCleanup(t);

		const next = await createQueuedRun(
			t,
			asUser,
			threadId,
			'next-message',
			'next-secret',
			'Next message'
		);

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: next.runId,
			executionSecret: 'next-secret',
			text: '',
			status: 'cancelled'
		});
		await finishImmediateCleanup(t);

		await createQueuedRun(
			t,
			asUser,
			threadId,
			'replacement',
			'replacement-secret',
			'Replacement message'
		);

		await finishImmediateCleanup(t);
		const parts = await transcriptParts(t, threadId);
		expect(parts.filter((part) => part.kind === 'prompt').map((part) => part.prompt?.text)).toEqual(
			['Do the thing', 'Next message', 'Replacement message']
		);
	});

	it('starts the queued startup deadline at accepted creation time', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'prior-run', 'prior-secret');
		await seedJobs(t, runId, 35, false);
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'prior-secret',
			text: '',
			status: 'failed'
		});
		await finishImmediateCleanup(t);
		const next = await createQueuedRun(t, asUser, threadId, 'next-message', 'next-secret');
		const state = await t.run((ctx) => getRunExecutionState(ctx.db, next.runId));
		expect(
			await t.run((ctx) => ctx.db.system.get('_scheduled_functions', state!.lifecycleCheckId!))
		).toMatchObject({ scheduledTime: Date.now() + RUN_QUEUED_STARTUP_DEADLINE_MS });

		await vi.advanceTimersByTimeAsync(RUN_QUEUED_STARTUP_DEADLINE_MS + 1);
		await t.finishInProgressScheduledFunctions();
		expect(await t.run((ctx) => ctx.db.get('runs', next.runId))).toMatchObject({
			status: 'failed'
		});
	});

	it('reconciles a long cancelled run history across bounded, idempotent transactions', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'prior-run', 'prior-secret');
		await seedJobs(t, runId, 35, false);
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'prior-secret',
			text: '',
			status: 'cancelled'
		});
		await finishImmediateCleanup(t);
		const runIds: Id<'runs'>[] = [];

		for (let index = 0; index < 20; index++) {
			const executionSecret = `next-secret-${index}`;

			const created = await createQueuedRun(
				t,
				asUser,
				threadId,
				`next-${index}`,
				executionSecret,
				`${index}:${'x'.repeat(950_000)}`
			);

			runIds.push(created.runId);
			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId: created.runId,
				executionSecret,
				text: '',
				status: 'cancelled'
			});
		}

		const next = await createQueuedRun(t, asUser, threadId, 'replacement', 'replacement-secret');
		await finishImmediateCleanup(t);
		const prompts = (await transcriptParts(t, threadId)).filter((part) => part.kind === 'prompt');
		expect(prompts.map((part) => part.runId)).toEqual([runId, ...runIds, next.runId]);
	});

	it('commits attachments and prompt in order on a retry after waiting, surviving Stop', async () => {
		const t = initConvexTest();
		const { asUser, subject, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'prior-run', 'prior-secret');
		await seedJobs(t, runId, 35, false);
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'prior-secret',
			text: '',
			status: 'failed'
		});

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
			threadId,
			submissionId: 'image-follow-up',
			executionSecret: 'next-secret',
			prompt: '',
			imageUploadIds: [imageUploadId]
		};

		expect(await asUser.mutation(api.agentRuntime.prepareSubmission, { threadId })).toBe(false);
		await expect(insertQueuedRun(t, asUser, args)).rejects.toThrow('SPROCKET_SUBMISSION_WAITING');
		await finishImmediateCleanup(t);

		const next = await insertQueuedRun(t, asUser, args);
		expect(await insertQueuedRun(t, asUser, args)).toMatchObject({
			created: false,
			runId: next.runId
		});
		expect(await t.run((ctx) => ctx.db.get('imageUploads', imageUploadId))).toMatchObject({
			attached: true,
			threadId
		});
		await asUser.mutation(api.agentRuntime.requestCancellation, {
			runId: next.runId
		});
		expect(
			await t.query(api.agentRuntime.isFinished, {
				runId: next.runId,
				executionSecret: 'next-secret'
			})
		).toBe(true);
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: next.runId,
			executionSecret: 'next-secret',
			text: '',
			status: 'cancelled'
		});
		await finishImmediateCleanup(t);
		const parts = await transcriptParts(t, threadId);
		const prompt = parts.find((part) => part.runId === next.runId);
		expect(prompt?.prompt).toMatchObject({
			text: '',
			imageUploads: [{ name: 'robot.png', storageId: expect.any(String) }]
		});

		for (const part of parts) {
			if (part.kind === 'tool') expect(part.number).toBeLessThan(prompt!.number);
		}

		expect(await insertQueuedRun(t, asUser, args)).toMatchObject({
			runId: next.runId,
			promptPart: prompt
		});
		expect(await t.run((ctx) => ctx.db.get('runs', next.runId))).toMatchObject({
			status: 'cancelled'
		});
	});

	it('accepts an empty continuation only after previous outcomes are recorded', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'prior-run', 'prior-secret');
		await seedJobs(t, runId, 35, false);
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'prior-secret',
			text: '',
			status: 'failed'
		});

		const args = {
			threadId,
			submissionId: 'continuation',
			executionSecret: 'next-secret',
			prompt: '',
			continuationOfRunId: runId
		};

		expect(await asUser.mutation(api.agentRuntime.prepareSubmission, { threadId })).toBe(false);
		await expect(insertQueuedRun(t, asUser, args)).rejects.toThrow('SPROCKET_SUBMISSION_WAITING');
		await finishImmediateCleanup(t);
		expect(await asUser.mutation(api.agentRuntime.prepareSubmission, { threadId })).toBe(true);

		const next = await insertQueuedRun(t, asUser, args);
		expect(await insertQueuedRun(t, asUser, args)).toMatchObject({
			created: false,
			runId: next.runId
		});
		expect(
			await t.query(api.agentRuntime.getContext, {
				runId: next.runId,
				executionSecret: 'next-secret'
			})
		).toMatchObject({ prompt: '', run: { continuationOfRunId: runId } });
		expect(
			(await transcriptParts(t, threadId))
				.filter((part) => part.kind === 'prompt')
				.map((part) => part.runId)
		).toEqual([runId]);
	});

	it('creates gateway runs only after prior cleanup without storing a waiting follow-up', async () => {
		vi.stubEnv('MODEL_GATEWAY_URL', 'https://gateway.example');

		try {
			const t = initConvexTest();
			const { asUser, threadId } = await seedOwnedThread(t);

			const request = {
				threadId,
				submissionId: 'legacy',
				executionSecret: 'legacy-secret',
				prompt: 'Legacy message',
				storageIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium' as const,
				fastMode: false
			};

			const legacy = await asUser.action(api.agentRuntime.createGatewayRun, request);
			expect(legacy).toMatchObject({
				promptPart: { prompt: { text: request.prompt } }
			});
			await t.mutation(api.agentRuntime.start, {
				runId: legacy.runId,
				executionSecret: request.executionSecret,
				claimId: 'legacy-claim'
			});
			await seedJobs(t, legacy.runId, 35, false);
			await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId: legacy.runId,
				executionSecret: request.executionSecret,
				status: 'failed',
				text: ''
			});

			const nextRequest = {
				...request,
				submissionId: 'next',
				executionSecret: 'next-secret',
				prompt: 'Follow-up'
			};

			expect(await asUser.mutation(api.agentRuntime.prepareSubmission, { threadId })).toBe(false);
			await expect(asUser.action(api.agentRuntime.createGatewayRun, nextRequest)).rejects.toThrow(
				'SPROCKET_SUBMISSION_WAITING'
			);
			expect(
				await t.run((ctx) =>
					ctx.db
						.query('runs')
						.withIndex('by_userId_submissionId', (q) =>
							q.eq('userId', 'user_alice').eq('submissionId', nextRequest.submissionId)
						)
						.unique()
				)
			).toBeNull();
			await finishImmediateCleanup(t);
			expect(await asUser.mutation(api.agentRuntime.prepareSubmission, { threadId })).toBe(true);
			const next = await asUser.action(api.agentRuntime.createGatewayRun, nextRequest);
			expect(next).toMatchObject({ created: true });
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('prepares an expired run across cleanup batches before accepting a follow-up', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'expired-run', 'prior-secret');
		await asUser.mutation(api.agentRuntime.start, {
			runId,
			executionSecret: 'prior-secret',
			claimId: 'expired-claim'
		});
		await seedJobs(t, runId, 35, true);
		await t.run((ctx) => patchRunExecution(ctx, runId, { claimExpiresAt: Date.now() - 1 }));

		expect(await asUser.mutation(api.agentRuntime.prepareSubmission, { threadId })).toBe(false);
		await expect(
			createQueuedRun(t, asUser, threadId, 'after-expiry', 'next-secret')
		).rejects.toThrow('SPROCKET_SUBMISSION_WAITING');
		expect(await t.run((ctx) => ctx.db.get('runs', runId))).toMatchObject({ status: 'failed' });

		await finishImmediateCleanup(t);

		expect(await asUser.mutation(api.agentRuntime.prepareSubmission, { threadId })).toBe(true);
		const next = await createQueuedRun(t, asUser, threadId, 'after-expiry', 'next-secret');
		expect(next.created).toBe(true);
	});

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
				lastError: 'The local agent stopped responding before this run finished.'
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

	it('keeps a newer run question answerable while cancelled questions await cleanup', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'old-questions', 'old-secret');
		const jobs = await seedJobs(t, runId, 35, false);
		await t.run(async (ctx) => {
			for (let sequence = 0; sequence < 35; sequence++) {
				await ctx.db.insert('agentQuestions', {
					threadId,
					runId,
					jobId: jobs[0]._id,
					question: 'Old question?',
					options: [{ id: 'yes', label: 'Yes' }],
					status: 'pending',
					createdAt: 1,
					timeoutAt: Date.now() + 60_000,
					sequence
				});
			}
		});
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'old-secret',
			text: '',
			status: 'cancelled'
		});
		await finishImmediateCleanup(t);
		const next = await createQueuedRun(t, asUser, threadId, 'new-question', 'new-secret');
		const [job] = await seedJobs(t, next.runId, 1, false);

		const questionId = await t.run((ctx) =>
			ctx.db.insert('agentQuestions', {
				threadId,
				runId: next.runId,
				jobId: job._id,
				question: 'New question?',
				options: [{ id: 'yes', label: 'Yes' }],
				status: 'pending',
				createdAt: Date.now(),
				timeoutAt: Date.now() + 60_000,
				sequence: 35
			})
		);

		expect(await asUser.query(api.agentQuestions.headPendingForThread, { threadId })).toMatchObject(
			{ questionId }
		);
		expect(
			await t.run(async (ctx) =>
				(await actionablePendingQuestionsForThread(ctx.db, threadId)).map(
					(question) => question._id
				)
			)
		).toEqual([questionId]);
		expect(
			await asUser.mutation(api.agentQuestions.answer, { threadId, questionId, optionId: 'yes' })
		).toMatchObject({ question: { status: 'answered' } });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});

	it('settles a root immediately after child cancellation while job cleanup is deferred', async () => {
		const t = initConvexTest();
		const { asUser, threadId: rootId, subject, repositoryKey } = await seedOwnedThread(t);
		const threadId = await seedThreadRecord(t, subject, repositoryKey);
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', threadId, { parentThreadId: rootId });
			await registerChildThread(ctx, (await ctx.db.get('threadRecords', threadId))!);
		});
		const { runId } = await createQueuedRun(t, asUser, threadId, 'child-cleanup', 'child-secret');
		const jobs = await seedJobs(t, runId, 35, false);
		await t.run(async (ctx) => {
			for (let sequence = 0; sequence < 35; sequence++) {
				await ctx.db.insert('agentQuestions', {
					threadId,
					runId,
					jobId: jobs[0]._id,
					question: 'Child question?',
					options: [{ id: 'yes', label: 'Yes' }],
					status: 'pending',
					createdAt: Date.now(),
					timeoutAt: Date.now() + 60_000,
					sequence
				});
			}
		});

		const rootSummary = () =>
			t.run(async (ctx) => subtreeSummary(ctx.db, (await ctx.db.get('threadRecords', rootId))!));

		expect(await rootSummary()).toMatchObject({ descendantCount: 1, anyActive: true });

		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId,
			executionSecret: 'child-secret',
			text: '',
			status: 'cancelled'
		});
		expect(await t.run((ctx) => ctx.db.query('agentQuestions').first())).toMatchObject({
			status: 'cancelled'
		});
		expect(await rootSummary()).toMatchObject({ descendantCount: 1, anyActive: false });
		await asUser.mutation(api.threads.settle, { threadId: rootId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await rootSummary()).toMatchObject({ descendantCount: 1, anyActive: false });
		expect(await t.run((ctx) => ctx.db.get('threadRecords', rootId))).toMatchObject({
			archivedAt: expect.any(Number)
		});
	});

	it.each(['cancelled', 'failed', 'completed'] as const)(
		'finishes %s jobs before processing questions across batches',
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

			const firstJob = await t.run((ctx) => ctx.db.get('executorJobs', jobs[0]._id));

			expect(firstJob?.status).toBe('cancelled');

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
				expect(await asUser.query(api.agentQuestions.headPendingForThread, { threadId })).toBe(
					null
				);
				await expect(
					asUser.mutation(api.agentQuestions.answer, {
						threadId,
						questionId: deferredQuestion!._id,
						optionId: 'yes'
					})
				).rejects.toThrow('Question is no longer awaiting an answer.');

				await t.mutation(internal.agentQuestions.timeout, {
					questionId: deferredQuestion!._id
				});

				expect(
					await t.run((ctx) => ctx.db.get('agentQuestions', deferredQuestion!._id))
				).toMatchObject({ status: 'cancelled' });
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
