import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { FunctionArgs } from 'convex/server';
import type { Id } from '@convex/_generated/dataModel';
import { executionSecretHash } from './lib/auth';
import { MESSAGE_QUEUE_LEASE_MS } from './lib/messageQueue';
import {
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	toolTranscriptAssignment
} from './test.setup';

afterEach(() => vi.useRealTimers());

async function fixture() {
	const t = initConvexTest();
	const { asUser, threadId, subject } = await seedOwnedThread(t);
	const machineId = 'machine-a';
	const credential = 'machine-secret';
	await t.run(async (ctx) => {
		await ctx.db.insert('machines', {
			userId: subject,
			machineId,
			credentialHash: await executionSecretHash(credential),
			friendlyName: 'Laptop',
			platform: 'linux',
			platformVersion: '1',
			architecture: 'x64',
			hostname: 'laptop',
			appVersion: 'test',
			runIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastSeenAt: Date.now()
		});
	});

	const request = (submissionId: string): FunctionArgs<typeof api.messageQueue.enqueue> => ({
		machineId,
		credential,
		threadId,
		submissionId,
		executionSecret: `secret-${submissionId}`,
		workspacePath: '/workspace',
		prompt: submissionId,
		storageIds: [],
		selectedModel: 'model-a',
		completionProvider: 'openai',
		reasoningEffort: 'high',
		fastMode: true
	});

	const enqueue = async (submissionId: string) => {
		await asUser.mutation(api.messageQueue.enqueue, request(submissionId));

		return await t.run(async (ctx) => {
			const row = await ctx.db
				.query('queuedMessages')
				.withIndex('by_userId_submissionId', (q) =>
					q.eq('userId', subject).eq('submissionId', submissionId)
				)
				.unique();

			return row!._id;
		});
	};

	const claim = (messageId: Id<'queuedMessages'>, claimId = 'claim-a') =>
		asUser.mutation(api.messageQueue.claim, {
			messageId,
			machineId,
			credential,
			claimId,
			continuationSubmissionId: `continuation-${claimId}`,
			continuationExecutionSecret: `continuation-secret-${claimId}`
		});

	const advanceLease = async () => {
		vi.setSystemTime(Date.now() + MESSAGE_QUEUE_LEASE_MS + 1);
		await t.run(async (ctx) => {
			const machine = await ctx.db.query('machines').first();
			await ctx.db.patch('machines', machine!._id, { lastSeenAt: Date.now() });
		});
	};

	const createRun = async (submissionId: string) => {
		const args = request(submissionId);

		return await insertQueuedRun(t, asUser, {
			...args,
			imageUploadIds: []
		});
	};

	return {
		t,
		asUser,
		subject,
		threadId,
		machineId,
		credential,
		request,
		enqueue,
		claim,
		advanceLease,
		createRun
	};
}

describe('durable message queue', () => {
	it.each([
		'worker',
		'browser race',
		'failed start',
		'cancelled parent',
		'lost acknowledgement',
		'terminal failed start',
		'lost failed-start acknowledgement',
		'claimed failure'
	])('recovers answered questions before follow-ups: %s', async (scenario) => {
		vi.useFakeTimers();

		const {
			t,
			asUser,
			subject,
			threadId,
			machineId,
			credential,
			enqueue,
			claim,
			advanceLease,
			createRun
		} = await fixture();

		const executionSecret = 'question-secret';

		const active = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'question-run',
			executionSecret,
			prompt: 'Need a choice'
		});

		const claimId = 'question-executor';
		await asUser.mutation(api.agentRuntime.start, {
			runId: active.runId,
			executionSecret,
			claimId
		});
		await asUser.mutation(api.agentRuntime.beginToolJob, {
			runId: active.runId,
			executionSecret,
			claimId,
			...toolTranscriptAssignment(active.runId, claimId),
			kind: 'ask_question',
			payload: { question: 'Which board?', options: [{ id: 'a', label: 'Board A' }] }
		});

		const question = await asUser.mutation(api.agentQuestions.create, {
			runId: active.runId,
			executionSecret,
			claimId,
			question: 'Which board?',
			options: [{ id: 'a', label: 'Board A' }]
		});

		const first = await enqueue('first');
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: active.runId,
			executionSecret,
			text: '',
			status: 'failed'
		});
		expect(await claim(first)).toBeNull();

		const answer = await asUser.mutation(api.agentQuestions.answer, {
			threadId,
			questionId: question.questionId,
			optionId: 'a'
		});

		if (scenario === 'cancelled parent') {
			await t.run(async (ctx) => {
				await ctx.db.patch('runs', active.runId, { status: 'cancelled' });
			});
			const followUp = await claim(first);
			expect(followUp).toMatchObject({ submissionId: 'first' });
			expect(followUp).not.toHaveProperty('continuation');

			return;
		}

		const recovered = await claim(first);
		expect(recovered?.continuation).toMatchObject({
			continuationOfRunId: active.runId,
			prompt: answer.continuation!.prompt,
			selectedModel: 'gpt-5.6-sol',
			completionProvider: 'spikonado',
			reasoningEffort: 'medium',
			fastMode: false
		});
		await expect(createRun('first')).rejects.toThrow('Send or remove queued messages');
		expect((await asUser.query(api.messageQueue.list, {}))[0]).not.toHaveProperty('continuation');
		expect(await claim(first, 'concurrent-worker')).toBeNull();
		// The browser disappears, then the native process crashes before launching.
		await advanceLease();
		const resumed = await claim(first, 'restarted-worker');
		expect(resumed?.continuation).toEqual(recovered!.continuation);

		if (scenario === 'failed start') {
			await asUser.mutation(api.messageQueue.finishAttempt, {
				messageId: first,
				claimId: 'restarted-worker',
				error: 'Provider unavailable'
			});
			expect((await asUser.query(api.messageQueue.list, {}))[0]).toMatchObject({
				status: 'failed'
			});
			await asUser.mutation(api.messageQueue.retry, { submissionId: 'first' });
			expect((await claim(first, 'retry-worker'))?.continuation).toEqual(recovered!.continuation);
		}

		let capability = resumed!.continuation!;

		let continuation = await insertQueuedRun(t, asUser, {
			threadId,
			...capability,
			submissionId: scenario === 'browser race' ? 'browser-continuation' : capability.submissionId,
			machineId
		});

		if (scenario === 'terminal failed start' || scenario === 'lost failed-start acknowledgement') {
			for (let attempt = 0; attempt < 2; attempt++) {
				await asUser.mutation(api.agentRuntime.finalizeFailedStart, {
					threadId,
					submissionId: capability.submissionId,
					executionSecret: capability.executionSecret,
					prompt: capability.prompt,
					storageIds: [],
					selectedModel: capability.selectedModel,
					completionProvider: capability.completionProvider,
					reasoningEffort: capability.reasoningEffort,
					fastMode: capability.fastMode,
					text: 'Run failed before starting.',
					lastError: 'Provider unavailable'
				});

				if (scenario === 'terminal failed start') {
					await asUser.mutation(api.messageQueue.finishAttempt, {
						messageId: first,
						claimId: attempt === 0 ? 'restarted-worker' : 'retry-start-0',
						error: 'Provider unavailable'
					});
				} else {
					await advanceLease();
					expect(await claim(first, 'recover-failed-start')).toBeNull();
				}

				expect((await asUser.query(api.messageQueue.list, {}))[0]).toMatchObject({
					status: 'failed',
					error: 'Provider unavailable'
				});
				expect(await claim(first)).toBeNull();
				await expect(createRun('first')).rejects.toThrow('Send or remove queued messages');
				await asUser.mutation(api.messageQueue.retry, { submissionId: 'first' });
				const retry = await claim(first, `retry-start-${attempt}`);
				expect(retry?.continuation).toMatchObject({
					continuationOfRunId: continuation.runId,
					prompt: '',
					selectedModel: capability.selectedModel
				});
				expect(retry?.continuation?.submissionId).not.toBe(capability.submissionId);
				expect(retry?.continuation?.executionSecret).not.toBe(capability.executionSecret);
				capability = retry!.continuation!;
				continuation = await insertQueuedRun(t, asUser, { threadId, ...capability, machineId });
			}

			// Retries replay the answer from the failed run's history without another prompt.
			const parts = await asUser.query(api.transcript.getParts, {
				threadId,
				numbers: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
			});

			expect(
				parts.parts.filter((part) => part.prompt?.text === answer.continuation!.prompt)
			).toHaveLength(1);
		}

		if (scenario === 'browser race') {
			// The browser wins run creation after the recovery lease was committed.
			await asUser.mutation(api.messageQueue.finishAttempt, {
				messageId: first,
				claimId: 'restarted-worker',
				error: 'Parent is no longer latest'
			});
			expect(await claim(first)).toBeNull();
		} else {
			// Crash after run creation: preserve the unclaimed continuation and capability.
			await t.mutation(api.machines.end, { userId: subject, machineId, credential });
			expect(await t.run((ctx) => ctx.db.get('runs', continuation.runId))).toMatchObject({
				status: 'queued'
			});
			await advanceLease();
			expect((await claim(first, 'after-run-crash'))?.continuation).toEqual(capability);
			expect((await insertQueuedRun(t, asUser, { threadId, ...capability, machineId })).runId).toBe(
				continuation.runId
			);
			await asUser.mutation(api.agentRuntime.start, {
				runId: continuation.runId,
				executionSecret: capability.executionSecret,
				claimId: 'continuation-executor'
			});

			if (scenario !== 'lost acknowledgement') {
				await asUser.mutation(api.messageQueue.finishAttempt, {
					messageId: first,
					claimId: 'after-run-crash'
				});
			}
		}

		expect(await claim(first)).toBeNull();
		await asUser.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: continuation.runId,
			executionSecret: capability.executionSecret,
			text: '',
			status: scenario === 'claimed failure' ? 'failed' : 'completed'
		});

		if (scenario === 'lost acknowledgement') {
			await advanceLease();
			expect(await claim(first)).toBeNull();
		}

		const followUp = await claim(first);
		expect(followUp).toMatchObject({
			submissionId: 'first',
			prompt: 'first',
			selectedModel: 'model-a',
			completionProvider: 'openai'
		});
		expect(followUp).not.toHaveProperty('continuation');
		expect((await createRun('first')).created).toBe(true);
	});
	it('preserves an unclaimed run across machine shutdown and process takeover', async () => {
		vi.useFakeTimers();

		const { t, asUser, subject, machineId, credential, enqueue, claim, createRun } =
			await fixture();

		const id = await enqueue('first');
		await claim(id);
		const created = await createRun('first');
		await t.mutation(api.machines.end, { userId: subject, machineId, credential });
		expect(await t.run((ctx) => ctx.db.get('runs', created.runId))).toMatchObject({
			status: 'queued'
		});
		expect(await t.run((ctx) => ctx.db.query('machines').first())).toMatchObject({
			runIds: [created.runId]
		});
		await asUser.mutation(api.machines.tryRegister, {
			machineId,
			credentialHash: await executionSecretHash('new-process'),
			friendlyName: 'Laptop',
			platform: 'linux',
			platformVersion: '1',
			architecture: 'x64',
			hostname: 'laptop',
			appVersion: 'test'
		});
		expect(await t.run((ctx) => ctx.db.get('runs', created.runId))).toMatchObject({
			status: 'queued'
		});
		expect(await t.run((ctx) => ctx.db.query('machines').first())).toMatchObject({
			runIds: [created.runId]
		});
	});

	it('retains unclaimed queue runs past startup deadlines but still expires active run claims', async () => {
		vi.useFakeTimers();
		const { t, asUser, enqueue, claim, createRun } = await fixture();
		await claim(await enqueue('first'));
		const created = await createRun('first');
		vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);

		const execution = await t.run((ctx) =>
			ctx.db
				.query('runExecutionStates')
				.withIndex('by_runId', (q) => q.eq('runId', created.runId))
				.unique()
		);

		await t.mutation(internal.runLifecycle.checkRun, {
			runId: created.runId,
			generation: execution!.lifecycleGeneration!
		});
		expect(await t.run((ctx) => ctx.db.get('runs', created.runId))).toMatchObject({
			status: 'queued'
		});
		await asUser.mutation(api.agentRuntime.start, {
			runId: created.runId,
			executionSecret: 'secret-first',
			claimId: 'executor'
		});
		vi.setSystemTime(Date.now() + MESSAGE_QUEUE_LEASE_MS + 1);

		const running = await t.run((ctx) =>
			ctx.db
				.query('runExecutionStates')
				.withIndex('by_runId', (q) => q.eq('runId', created.runId))
				.unique()
		);

		await t.mutation(internal.runLifecycle.checkRun, {
			runId: created.runId,
			generation: running!.lifecycleGeneration!
		});
		expect(await t.run((ctx) => ctx.db.get('runs', created.runId))).toMatchObject({
			status: 'failed'
		});
	});
	it('restores the FIFO queue and settings in a fresh authenticated client', async () => {
		const { t, asUser, subject, enqueue, claim } = await fixture();
		const first = await enqueue('first');
		const second = await enqueue('second');
		const reconnected = t.withIdentity({ subject });
		expect(await reconnected.query(api.messageQueue.list, {})).toEqual(
			await asUser.query(api.messageQueue.list, {})
		);
		expect((await reconnected.query(api.messageQueue.list, {})).map((row) => row.id)).toEqual([
			'first',
			'second'
		]);
		expect(await claim(second)).toBeNull();
		expect(await claim(first)).toMatchObject({
			selectedModel: 'model-a',
			completionProvider: 'openai',
			reasoningEffort: 'high',
			fastMode: true
		});
	});

	it('leases a single head across concurrent workers and recovers after a crash before launch', async () => {
		vi.useFakeTimers();
		const { enqueue, claim, advanceLease } = await fixture();
		const id = await enqueue('first');
		const claims = await Promise.all([claim(id, 'worker-a'), claim(id, 'worker-b')]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(await claim(id, 'worker-c')).toBeNull();
		await advanceLease();
		expect(await claim(id, 'worker-c')).toMatchObject({
			submissionId: 'first',
			executionSecret: 'secret-first',
			status: 'sending',
			claimId: 'worker-c'
		});
	});

	it('recovers a crash after run creation with the same run and one prompt', async () => {
		vi.useFakeTimers();
		const { t, enqueue, claim, advanceLease, createRun } = await fixture();
		const id = await enqueue('first');
		await claim(id);
		const created = await createRun('first');
		await advanceLease();
		expect(await claim(id, 'worker-restarted')).toMatchObject({ executionSecret: 'secret-first' });
		const recovered = await createRun('first');
		expect(recovered).toMatchObject({ created: false, runId: created.runId });

		const prompts = await t.run(async (ctx) =>
			(await ctx.db.query('threadTranscriptParts').collect()).filter((part) => part.prompt)
		);

		expect(prompts).toHaveLength(1);
	});

	it.each(['running', 'completed', 'failed', 'cancelled'] as const)(
		'reconciles a lost acknowledgement for a %s run without another launch',
		async (status) => {
			vi.useFakeTimers();
			const { t, asUser, enqueue, claim, createRun, advanceLease } = await fixture();
			const first = await enqueue('first');
			await enqueue('second');
			await claim(first);
			const run = await createRun('first');
			await t.run(async (ctx) => {
				await ctx.db.patch('runs', run.runId, { status });
			});
			await advanceLease();
			expect(await claim(first, 'restarted')).toBeNull();
			expect((await asUser.query(api.messageQueue.list, {})).map((row) => row.id)).toEqual([
				'second'
			]);
			await asUser.mutation(api.messageQueue.enqueue, {
				machineId: 'machine-a',
				credential: 'machine-secret',
				threadId: run.threadId,
				submissionId: 'first',
				executionSecret: 'secret-first',
				workspacePath: '/workspace',
				prompt: 'first',
				storageIds: [],
				selectedModel: 'model-a',
				completionProvider: 'openai',
				reasoningEffort: 'high',
				fastMode: true
			});
			expect(await t.run(async (ctx) => ctx.db.query('queuedMessages').collect())).toHaveLength(1);
		}
	);

	it('waits for active runs and prevents ordinary submissions overtaking the queue', async () => {
		const { t, asUser, threadId, enqueue, claim, createRun } = await fixture();

		const active = await insertQueuedRun(t, asUser, {
			threadId,
			submissionId: 'active',
			executionSecret: 'active-secret',
			prompt: 'active'
		});

		await asUser.mutation(api.agentRuntime.start, {
			runId: active.runId,
			executionSecret: 'active-secret',
			claimId: 'active-claim'
		});
		const id = await enqueue('first');
		expect(await claim(id)).toBeNull();
		await expect(createRun('overtake')).rejects.toThrow('Send or remove queued messages');
		await t.run(async (ctx) => {
			await ctx.db.patch('runs', active.runId, { status: 'completed' });
		});
		expect(await claim(id)).toMatchObject({ submissionId: 'first' });
	});

	it('persists failures, blocks later messages, and retries the original capability', async () => {
		const { asUser, enqueue, claim } = await fixture();
		const first = await enqueue('first');
		const second = await enqueue('second');
		await claim(first);
		await asUser.mutation(api.messageQueue.finishAttempt, {
			messageId: first,
			claimId: 'claim-a',
			error: 'Workspace unavailable'
		});
		expect((await asUser.query(api.messageQueue.list, {}))[0]).toMatchObject({
			status: 'failed',
			error: 'Workspace unavailable'
		});
		expect(await claim(second)).toBeNull();
		await asUser.mutation(api.messageQueue.retry, { submissionId: 'first' });
		expect(await claim(first, 'retry')).toMatchObject({
			executionSecret: 'secret-first',
			submissionId: 'first'
		});
	});

	it('ignores stale acknowledgements and refuses removal while sending', async () => {
		vi.useFakeTimers();
		const { asUser, enqueue, claim, advanceLease } = await fixture();
		const id = await enqueue('first');
		await claim(id);
		await advanceLease();
		await claim(id, 'restarted');
		await asUser.mutation(api.messageQueue.finishAttempt, {
			messageId: id,
			claimId: 'claim-a',
			error: 'stale error'
		});
		expect((await asUser.query(api.messageQueue.list, {}))[0]?.status).toBe('sending');
		await expect(
			asUser.mutation(api.messageQueue.remove, { submissionId: 'first' })
		).rejects.toThrow('being sent');
	});

	it('isolates users and machines and keeps the execution capability out of UI queries', async () => {
		const { t, asUser, enqueue, claim, machineId, credential } = await fixture();
		const id = await enqueue('first');
		const other = t.withIdentity({ subject: 'user_other' });
		expect(await other.query(api.messageQueue.list, {})).toEqual([]);
		await other.mutation(api.messageQueue.remove, { submissionId: 'first' });
		expect(
			await other.mutation(api.messageQueue.claim, {
				messageId: id,
				machineId,
				credential,
				claimId: 'other',
				continuationSubmissionId: 'other-continuation',
				continuationExecutionSecret: 'other-secret'
			})
		).toBeNull();
		expect(
			await asUser.mutation(api.messageQueue.claim, {
				messageId: id,
				machineId: 'other-machine',
				credential,
				claimId: 'other',
				continuationSubmissionId: 'other-continuation',
				continuationExecutionSecret: 'other-secret'
			})
		).toBeNull();
		await expect(
			asUser.mutation(api.messageQueue.claim, {
				messageId: id,
				machineId,
				credential: 'wrong',
				claimId: 'wrong',
				continuationSubmissionId: 'wrong-continuation',
				continuationExecutionSecret: 'wrong-secret'
			})
		).rejects.toThrow('not active');
		expect((await asUser.query(api.messageQueue.list, {}))[0]).not.toHaveProperty(
			'executionSecret'
		);
		expect(await claim(id)).not.toBeNull();
	});

	it('deduplicates enqueue and rejects changed content using the same submission id', async () => {
		const { t, asUser, enqueue, request } = await fixture();
		await enqueue('first');
		await asUser.mutation(api.messageQueue.enqueue, request('first'));
		expect(await t.run(async (ctx) => ctx.db.query('queuedMessages').collect())).toHaveLength(1);
		await expect(
			asUser.mutation(api.messageQueue.enqueue, { ...request('first'), prompt: 'changed' })
		).rejects.toThrow('does not match');
	});

	it('pins attachments past orphan and attached-file retention and releases them on removal', async () => {
		vi.useFakeTimers();
		const { t, asUser, subject, request, threadId } = await fixture();

		const storageId = await t.run(async (ctx) => {
			const id = await ctx.storage.store(new Blob(['board'], { type: 'image/png' }));
			await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId: id,
				name: 'board.png',
				mediaType: 'image/png',
				size: 5,
				attached: false
			});

			return id;
		});

		await asUser.mutation(api.messageQueue.enqueue, {
			...request('first'),
			storageIds: [storageId]
		});
		vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
		expect(await t.mutation(internal.imageUploads.cleanupOrphans, {})).toBe(0);
		expect(await asUser.mutation(api.imageUploads.discardFile, { storageId })).toBe(false);
		await t.run(async (ctx) => {
			const upload = await ctx.db.query('imageUploads').first();
			await ctx.db.patch('imageUploads', upload!._id, { attached: true, threadId });
		});
		expect(await t.mutation(internal.imageUploads.cleanupExpired, {})).toBe(0);
		await asUser.mutation(api.messageQueue.remove, { submissionId: 'first' });
		expect(await t.run(async (ctx) => ctx.db.query('queuedMessageAttachments').collect())).toEqual(
			[]
		);
		expect(await t.mutation(internal.imageUploads.cleanupExpired, {})).toBe(1);
	});

	it('deletes unused draft bytes when the last queued reference is removed', async () => {
		const { t, asUser, subject, request } = await fixture();

		const storageId = await t.run(async (ctx) => {
			const id = await ctx.storage.store(new Blob(['draft']));
			await ctx.db.insert('imageUploads', {
				userId: subject,
				storageId: id,
				name: 'draft.txt',
				mediaType: 'text/plain',
				size: 5,
				attached: false
			});

			return id;
		});

		await asUser.mutation(api.messageQueue.enqueue, {
			...request('first'),
			storageIds: [storageId]
		});
		await asUser.mutation(api.messageQueue.enqueue, {
			...request('second'),
			storageIds: [storageId]
		});
		await asUser.mutation(api.messageQueue.remove, { submissionId: 'first' });
		expect(await t.run(async (ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();
		await asUser.mutation(api.messageQueue.remove, { submissionId: 'second' });
		expect(await t.run(async (ctx) => ctx.storage.getUrl(storageId))).toBeNull();
	});
});
