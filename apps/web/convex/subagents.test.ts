import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FunctionArgs } from 'convex/server';
import { api, internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { executionSecretHash } from '@convex/lib/auth';
import { RUN_ABANDONED_BY_AGENT } from '@convex/lib/agentErrors';
import { RUN_CLAIM_LEASE_DURATION_MS } from '@convex/lib/runLease';
import { AUTOMATIC_RECOVERY_SUBMISSION_PREFIX } from '@convex/lib/runRecovery';
import {
	createQueuedRun,
	initConvexTest,
	insertQueuedRun,
	seedOwnedThread,
	toolTranscriptAssignment,
	type ConvexTestInstance
} from './test.setup';

const machine = {
	machineId: 'machine-a',
	friendlyName: 'Workshop',
	platform: 'linux',
	platformVersion: '6.12.1',
	architecture: 'x86_64',
	hostname: 'workbench',
	appVersion: '0.3.2'
};

const MACHINE_CREDENTIAL = 'machine-credential';

type CallerRun = {
	asUser: ReturnType<ConvexTestInstance['withIdentity']>;
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	claimId: string;
	executionSecret: string;
};

async function registerActiveMachine(asUser: CallerRun['asUser']) {
	await asUser.mutation(api.machines.tryRegister, {
		...machine,
		credentialHash: await executionSecretHash(MACHINE_CREDENTIAL)
	});
}

async function startCallerRun(t: ConvexTestInstance, subject = 'user_alice'): Promise<CallerRun> {
	const asUser = t.withIdentity({ subject });
	const { threadId } = await seedOwnedThread(t, subject);

	const caller = {
		asUser,
		threadId,
		claimId: 'caller-claim',
		executionSecret: `caller-secret-${Math.random()}`
	};

	await registerActiveMachine(asUser);

	const created = await createQueuedRun(
		t,
		asUser,
		threadId,
		`caller-submission-${Math.random()}`,
		caller.executionSecret,
		'Root task'
	);

	// The queued run executes on the caller's machine.
	await t.run(async (ctx) => {
		await ctx.db.patch('runs', created.runId, { machineId: machine.machineId });
	});

	await t.mutation(api.agentRuntime.start, {
		runId: created.runId,
		claimId: caller.claimId,
		executionSecret: caller.executionSecret
	});

	return { ...caller, runId: created.runId };
}

type CreateOrSendArgs = FunctionArgs<typeof api.subagents.createOrSend>;

function createArgs(
	caller: Pick<CallerRun, 'runId' | 'claimId' | 'executionSecret'>,
	overrides: Partial<CreateOrSendArgs> = {}
): CreateOrSendArgs {
	return {
		runId: caller.runId,
		claimId: caller.claimId,
		executionSecret: caller.executionSecret,
		submissionId: `child-submission-${Math.random()}`,
		childExecutionSecret: `child-secret-${Math.random()}`,
		prompt: 'Do the delegated thing',
		model: 'gpt-5.6-sol',
		reasoning: 'medium',
		fast: false,
		...overrides
	};
}

async function createChild(t: ConvexTestInstance, caller: CallerRun) {
	return await t.mutation(api.subagents.createOrSend, createArgs(caller));
}

async function finishTreeCancellation(t: ConvexTestInstance, threadId: Id<'threadRecords'>) {
	for (let attempt = 0; attempt < 100; attempt++) {
		await vi.advanceTimersByTimeAsync(1);
		await t.finishInProgressScheduledFunctions();

		if (!(await t.run((ctx) => ctx.db.get('threadRecords', threadId)))?.treeCancellation) return;
	}

	throw new Error('Tree cancellation did not finish.');
}

/** Claim a child's queued run with the exact secret chosen at create time —
 * the same secret the native launcher reuses for start/renew/getContext. */
async function claimChildRun(
	t: ConvexTestInstance,
	child: { runId: Id<'runs'>; threadId: Id<'threadRecords'> },
	childExecutionSecret: string,
	claimId = 'child-claim'
) {
	await t.mutation(api.agentRuntime.start, {
		runId: child.runId,
		claimId,
		executionSecret: childExecutionSecret
	});

	return {
		runId: child.runId,
		threadId: child.threadId,
		claimId,
		executionSecret: childExecutionSecret
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('subagents.createOrSend', () => {
	it('rejects delegated child follow-ups until prior results are committed', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const args = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, args);
		await t.run(async (ctx) => {
			for (let sequence = 0; sequence < 35; sequence++) {
				await ctx.db.insert('executorJobs', {
					threadId: child.threadId,
					runId: child.runId,
					sequence,
					kind: 'exec_command',
					payload: { cmd: 'true' },
					status: 'claimed',
					enqueuedAt: Date.now()
				});
			}
		});
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: child.runId,
			executionSecret: args.childExecutionSecret,
			text: '',
			status: 'failed'
		});

		const followUpArgs = createArgs(caller, {
			threadId: child.threadId,
			prompt: 'Use the results'
		});

		const prepare = () =>
			t.mutation(api.subagents.prepareSubmission, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: child.threadId
			});

		expect(await prepare()).toBe(false);
		await expect(t.mutation(api.subagents.createOrSend, followUpArgs)).rejects.toThrow(
			'SPROCKET_SUBMISSION_WAITING'
		);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query('runs')
					.withIndex('by_userId_submissionId', (q) =>
						q.eq('userId', 'user_alice').eq('submissionId', followUpArgs.submissionId)
					)
					.unique()
			)
		).toBeNull();

		for (;;) {
			const pending = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());

			if (
				!pending.some(
					(entry) => entry.state.kind === 'pending' && entry.scheduledTime <= Date.now()
				)
			)
				break;
			await vi.advanceTimersByTimeAsync(1);
			await t.finishInProgressScheduledFunctions();
		}

		expect(await prepare()).toBe(true);

		const next = await t.mutation(api.subagents.createOrSend, followUpArgs);

		const recovered = await t.mutation(api.subagents.recoverSubmission, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			submissionId: followUpArgs.submissionId,
			childExecutionSecret: followUpArgs.childExecutionSecret
		});

		expect(recovered).toMatchObject({
			runId: next.runId,
			prompt: 'Use the results',
			settings: next.settings
		});
		const auth = { runId: next.runId, executionSecret: followUpArgs.childExecutionSecret };
		expect(
			await t.mutation(api.agentRuntime.start, { ...auth, claimId: 'queued-claim' })
		).toMatchObject({ claimed: true });
		expect(await t.query(api.agentRuntime.getContext, auth)).toMatchObject({
			prompt: 'Use the results'
		});
	});

	it('recovers committed settings and prompt independently of later saved settings', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const args = createArgs(caller);

		const recoveryArgs = {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			submissionId: args.submissionId,
			childExecutionSecret: args.childExecutionSecret
		};

		expect(await t.mutation(api.subagents.recoverSubmission, recoveryArgs)).toBeNull();
		const created = await t.mutation(api.subagents.createOrSend, args);
		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', created.threadId, {
				selectedModel: 'different-model',
				reasoningEffort: 'high',
				fastMode: true,
				completionProvider: 'openai'
			});
		});
		expect(await t.mutation(api.subagents.recoverSubmission, recoveryArgs)).toMatchObject({
			threadId: created.threadId,
			runId: created.runId,
			prompt: args.prompt,
			settings: created.settings
		});
		await expect(
			t.mutation(api.subagents.recoverSubmission, {
				...recoveryArgs,
				childExecutionSecret: 'wrong-secret'
			})
		).rejects.toThrow(/different executor/);

		await expect(
			t.mutation(api.subagents.recoverSubmission, {
				...recoveryArgs,
				claimId: 'stale-claim'
			})
		).rejects.toThrow(/no longer active/);
	});

	it('creates and retries one child with its parent, chosen secret, machine, and prompt', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const args = createArgs(caller);

		const created = await t.mutation(api.subagents.createOrSend, args);

		const [thread, run] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.get('threadRecords', created.threadId),
				ctx.db.get('runs', created.runId)
			])
		);

		expect(created.threadId).not.toBe(caller.threadId);
		expect(thread).toMatchObject({
			parentThreadId: caller.threadId,
			repositoryKey: 'alpha',
			status: 'queued',
			completionProvider: 'spikonado'
		});
		expect(run).toMatchObject({
			threadId: created.threadId,
			status: 'queued',
			machineId: machine.machineId
		});
		expect(await t.mutation(api.subagents.createOrSend, args)).toEqual(created);
		await expect(
			t.mutation(api.subagents.createOrSend, {
				...args,
				childExecutionSecret: 'different-secret'
			})
		).rejects.toThrow(/different executor/);

		// The parent secret cannot claim the child's run; the chosen child secret can.
		await expect(
			t.mutation(api.agentRuntime.start, {
				runId: created.runId,
				claimId: 'wrong-claim',
				executionSecret: caller.executionSecret
			})
		).rejects.toThrow(/Run not found/);

		const childRun = await claimChildRun(t, created, args.childExecutionSecret);
		expect(childRun.runId).toBe(created.runId);

		const parts = await t.run(async (ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (q) => q.eq('threadId', created.threadId))
				.collect()
		);

		expect(parts).toHaveLength(1);
		expect(parts[0].prompt?.text).toBe('Do the delegated thing');
	});

	it('rejects reusing the parent secret and empty prompts', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);

		await expect(
			t.mutation(
				api.subagents.createOrSend,
				createArgs(caller, { childExecutionSecret: caller.executionSecret })
			)
		).rejects.toThrow(/fresh execution secret/);

		await expect(
			t.mutation(api.subagents.createOrSend, createArgs(caller, { prompt: '  ' }))
		).rejects.toThrow(/nonempty prompt/);
	});

	it('rejects a busy follow-up without recording a prompt or mutating settings', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const child = await createChild(t, caller);

		const before = await t.run((ctx) => ctx.db.get('threadRecords', child.threadId));

		await expect(
			t.mutation(
				api.subagents.createOrSend,
				createArgs(caller, {
					threadId: child.threadId,
					prompt: 'Another task',
					model: 'other-model'
				})
			)
		).rejects.toThrow(
			'Stop the current run or wait for it to finish before sending another message.'
		);

		const after = await t.run((ctx) => ctx.db.get('threadRecords', child.threadId));
		expect(after?.selectedModel).toBe(before?.selectedModel);
		expect(after?.reasoningEffort).toBe(before?.reasoningEffort);

		const parts = await t.run(async (ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (q) => q.eq('threadId', child.threadId))
				.collect()
		);

		expect(parts).toHaveLength(1);
	});

	it('rejects a follow-up while a completed run has an actionable question waiting', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const childArgs = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, childArgs);
		const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);

		await t.mutation(api.agentRuntime.beginToolJob, {
			runId: child.runId,
			claimId: childRun.claimId,
			...toolTranscriptAssignment(child.runId, childRun.claimId),
			kind: 'ask_question',
			payload: { question: 'placeholder', options: [{ id: 'a', label: 'A' }] },
			executionSecret: childRun.executionSecret
		});

		await t.mutation(api.agentQuestions.create, {
			runId: child.runId,
			claimId: childRun.claimId,
			question: 'Need an answer?',
			options: [{ id: 'one', label: 'One' }],
			timeoutMs: 60_000,
			executionSecret: childRun.executionSecret
		});

		// Complete the run; the pending question keeps the thread waiting.
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: child.runId,
			text: 'done',
			status: 'completed',
			executionSecret: childRun.executionSecret
		});

		const before = await t.run((ctx) => ctx.db.get('threadRecords', child.threadId));

		await expect(
			t.mutation(
				api.subagents.createOrSend,
				createArgs(caller, { threadId: child.threadId, prompt: 'Another task' })
			)
		).rejects.toThrow(/Answer or cancel pending questions/);

		const after = await t.run((ctx) => ctx.db.get('threadRecords', child.threadId));
		expect(after?.selectedModel).toBe(before?.selectedModel);
	});

	it('follow-up keeps the target saved provider and persists resolved settings', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const childArgs = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, childArgs);

		await t.run(async (ctx) => {
			await ctx.db.patch('threadRecords', child.threadId, { completionProvider: 'openai' });
		});

		const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: child.runId,
			text: 'done',
			status: 'completed',
			executionSecret: childRun.executionSecret
		});

		const followUp = await t.mutation(
			api.subagents.createOrSend,
			createArgs(caller, {
				threadId: child.threadId,
				prompt: 'Follow-up task',
				model: 'gpt-5.6-sol',
				reasoning: 'high',
				fast: true
			})
		);

		expect(followUp.threadId).toBe(child.threadId);
		expect(followUp.settings).toMatchObject({
			model: 'gpt-5.6-sol',
			reasoning: 'high',
			fast: true,
			completionProvider: 'openai'
		});
	});

	it('a new prompt starts a failed child and retries the same submission', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const childArgs = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, childArgs);
		const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);

		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: child.runId,
			text: 'failed',
			status: 'failed',
			lastError: 'boom',
			executionSecret: childRun.executionSecret
		});

		const continuedArgs = createArgs(caller, {
			threadId: child.threadId,
			prompt: 'Fix the failure'
		});

		const continued = await t.mutation(api.subagents.createOrSend, continuedArgs);
		expect(continued.threadId).toBe(child.threadId);
		expect(continued.continuationOfRunId).toBeUndefined();

		await claimChildRun(t, continued, continuedArgs.childExecutionSecret);

		const retry = await t.mutation(api.subagents.createOrSend, continuedArgs);
		expect(retry.threadId).toBe(child.threadId);
		expect(retry.runId).toBe(continued.runId);
		expect(retry.continuationOfRunId).toBeUndefined();

		const parts = await t.run(async (ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (q) => q.eq('threadId', child.threadId))
				.collect()
		);

		expect(parts.map((part) => part.prompt?.text)).toEqual([childArgs.prompt, 'Fix the failure']);
	});

	it('enforces the 64-active-runs-per-machine limit for delegated creates', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);

		await t.run(async (ctx) => {
			const machineDoc = await ctx.db
				.query('machines')
				.withIndex('by_userId_and_machineId', (q) =>
					q.eq('userId', 'user_alice').eq('machineId', machine.machineId)
				)
				.unique();

			const filler: Id<'runs'>[] = [];

			for (let index = 0; index < 64; index += 1) {
				const runId = await ctx.db.insert('runs', {
					threadId: caller.threadId,
					userId: 'user_alice',
					submissionId: `filler-${index}`,
					status: 'running',
					executionSecretHash: await executionSecretHash(`filler-secret-${index}`),
					selectedModel: 'gpt-5.6-sol',
					reasoningEffort: 'medium',
					fastMode: false,
					startedAt: Date.now(),
					machineId: machine.machineId
				});

				await ctx.db.insert('runExecutionStates', { runId, completionAttemptSeq: 0 });
				filler.push(runId);
			}

			await ctx.db.patch('machines', machineDoc!._id, { runIds: filler });
		});

		await expect(t.mutation(api.subagents.createOrSend, createArgs(caller))).rejects.toThrow(
			/too many active runs/
		);
	});
});

describe('subagent tool job results', () => {
	it.each(['spawn', 'legacy follow-up', 'send', 'send with options', 'stop', 'poll'] as const)(
		'commits and retrieves the %s payload and result through the executor lifecycle',
		async (action) => {
			const t = initConvexTest();
			const caller = await startCallerRun(t);
			const child = await createChild(t, caller);

			const followUp = { threadId: child.threadId, prompt: 'Follow-up task', yieldTimeMs: 0 };

			const metadata = {
				status: 'running' as const,
				lastError: null,
				pendingQuestions: []
			};

			const snapshot = {
				...metadata,
				entries: [{ type: 'text' as const, id: 'part-1', text: 'Progress' }],
				nextCursor: 'cursor-1',
				hasMore: false
			};

			const sendResult = { ...metadata, threadId: child.threadId, settings: child.settings };

			const cases = {
				spawn: {
					kind: 'spawn_subagent',
					payload: { prompt: 'Delegate work', yieldTimeMs: 0 },
					result: sendResult
				},
				'legacy follow-up': { kind: 'spawn_subagent', payload: followUp, result: sendResult },
				send: {
					kind: 'control_subagent',
					payload: { ...followUp, action: 'send' },
					result: sendResult
				},
				'send with options': {
					kind: 'control_subagent',
					payload: {
						...followUp,
						action: 'send',
						yieldTimeMs: 10_000,
						model: 'gpt-5.6-sol',
						reasoning: 'high',
						fast: true,
						timeoutMs: 30_000
					},
					result: { ...sendResult, ...snapshot }
				},
				stop: {
					kind: 'control_subagent',
					payload: { threadId: child.threadId, action: 'stop', yieldTimeMs: 0 },
					result: { ...metadata, status: 'cancelled' }
				},
				poll: {
					kind: 'poll_subagent',
					payload: { threadId: child.threadId, yieldTimeMs: 0 },
					result: snapshot
				}
			} as const;

			const { kind, payload, result } = cases[action];

			const job = await t.mutation(api.agentRuntime.beginToolJob, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				...toolTranscriptAssignment(caller.runId, caller.claimId),
				kind,
				payload
			});

			await expect(
				t.mutation(api.executor.complete, {
					runId: caller.runId,
					claimId: caller.claimId,
					executionSecret: caller.executionSecret,
					jobId: job.jobId,
					result
				})
			).resolves.toBe(true);
			await expect(
				t.query(api.executor.getJob, {
					runId: caller.runId,
					executionSecret: caller.executionSecret,
					jobId: job.jobId
				})
			).resolves.toMatchObject({ status: 'completed', result });
			expect(await t.run((ctx) => ctx.db.get('executorJobs', job.jobId))).toMatchObject({
				kind,
				payload,
				result
			});
		}
	);
});

describe('subagents access control', () => {
	it('lets a grandparent control a grandchild but rejects siblings and unrelated threads', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const childArgs = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, childArgs);
		const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);

		const grandchildArgs = createArgs(childRun);

		const grandchild = await t.mutation(api.subagents.createOrSend, grandchildArgs);

		await expect(
			t.mutation(api.subagents.snapshot, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: grandchild.threadId
			})
		).resolves.toMatchObject({ settings: grandchild.settings });

		const grandchildRun = await claimChildRun(t, grandchild, grandchildArgs.childExecutionSecret);

		await expect(
			t.mutation(api.subagents.snapshot, {
				runId: grandchildRun.runId,
				claimId: grandchildRun.claimId,
				executionSecret: grandchildRun.executionSecret,
				threadId: child.threadId
			})
		).rejects.toThrow();

		const otherCaller = await startCallerRun(t);
		await expect(
			t.mutation(api.subagents.snapshot, {
				runId: otherCaller.runId,
				claimId: otherCaller.claimId,
				executionSecret: otherCaller.executionSecret,
				threadId: grandchild.threadId
			})
		).rejects.toThrow();

		const foreign = await startCallerRun(t, 'user_bob');
		await expect(
			t.mutation(api.subagents.snapshot, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: foreign.threadId
			})
		).rejects.toThrow();
	});

	it('lists immediate children by default and requires descendant access for other parents', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const first = await createChild(t, caller);
		const second = await createChild(t, caller);

		const listing = await t.mutation(api.subagents.listChildren, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			paginationOpts: { numItems: 10, cursor: null }
		});

		expect(listing.page.map((entry) => entry.threadId).sort()).toEqual(
			[first.threadId, second.threadId].sort()
		);
		expect(listing.isDone).toBe(true);
		expect(listing.page[0].settings.model).toBe('gpt-5.6-sol');

		const childArgs = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, childArgs);
		const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);
		await expect(
			t.mutation(api.subagents.listChildren, {
				runId: childRun.runId,
				claimId: childRun.claimId,
				executionSecret: childRun.executionSecret,
				parentThreadId: caller.threadId,
				paginationOpts: { numItems: 10, cursor: null }
			})
		).rejects.toThrow();
	});

	it('rejects expired-claim reads and controls', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const child = await createChild(t, caller);

		// Let the caller's claim lease lapse.
		await vi.advanceTimersByTimeAsync(RUN_CLAIM_LEASE_DURATION_MS + 1_000);

		await expect(
			t.mutation(api.subagents.snapshot, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: child.threadId
			})
		).rejects.toThrow(/no longer active/);

		await expect(
			t.mutation(api.subagents.control, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: child.threadId,
				action: 'stop'
			})
		).rejects.toThrow(/no longer active/);
	});
});

describe('subagents.control', () => {
	it('stops a large historical tree in batches and blocks new descendant work during traversal', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const childArgs = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, childArgs);
		const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);
		const grandchildArgs = createArgs(childRun);
		const grandchild = await t.mutation(api.subagents.createOrSend, grandchildArgs);
		const grandchildRun = await claimChildRun(t, grandchild, grandchildArgs.childExecutionSecret);

		for (let batch = 0; batch < 10; batch++) {
			await t.run(async (ctx) => {
				const thread = (await ctx.db.get('threadRecords', child.threadId))!;

				for (let index = 0; index < 40; index++) {
					const submissionId = `historical-${batch}-${index}`;

					const threadId = await ctx.db.insert('threadRecords', {
						userId: thread.userId,
						submissionId,
						parentThreadId: child.threadId,
						status: 'completed',
						repositoryKey: thread.repositoryKey,
						selectedModel: thread.selectedModel,
						reasoningEffort: thread.reasoningEffort,
						fastMode: thread.fastMode,
						lastMessageAt: Date.now() + 1
					});

					const runId = await ctx.db.insert('runs', {
						threadId,
						userId: thread.userId,
						submissionId,
						status: 'completed',
						executionSecretHash: 'historical',
						selectedModel: thread.selectedModel,
						reasoningEffort: thread.reasoningEffort,
						fastMode: thread.fastMode,
						startedAt: Date.now(),
						completedAt: Date.now()
					});

					await ctx.db.insert('runExecutionStates', { runId, completionAttemptSeq: 0 });
				}
			});
		}

		await caller.asUser.mutation(api.agentRuntime.requestCancellation, { runId: child.runId });
		expect(
			(await t.run((ctx) => ctx.db.get('threadRecords', child.threadId)))?.treeCancellation
		).toBeDefined();
		await expect(t.mutation(api.subagents.createOrSend, createArgs(grandchildRun))).rejects.toThrow(
			/tree is being stopped/
		);
		await expect(
			insertQueuedRun(t, caller.asUser, {
				threadId: grandchild.threadId,
				submissionId: 'manual-during-tree-stop',
				executionSecret: 'manual-secret',
				prompt: 'New work'
			})
		).rejects.toThrow(/tree is being stopped/);
		await finishTreeCancellation(t, child.threadId);
		expect(
			(await t.run((ctx) => ctx.db.get('runs', grandchild.runId)))?.cancellationRequestedAt
		).toBeDefined();
	}, 30_000);

	async function childWithPendingQuestion(
		t: ConvexTestInstance,
		timeoutMs: number | null = 60_000
	) {
		const caller = await startCallerRun(t);
		const childArgs = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, childArgs);
		const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);

		await t.mutation(api.agentRuntime.beginToolJob, {
			runId: child.runId,
			claimId: childRun.claimId,
			...toolTranscriptAssignment(child.runId, childRun.claimId),
			kind: 'ask_question',
			payload: { question: 'placeholder', options: [{ id: 'a', label: 'A' }] },
			executionSecret: childRun.executionSecret
		});

		const question = await t.mutation(api.agentQuestions.createWithOptionalExpiry, {
			runId: child.runId,
			claimId: childRun.claimId,
			question: 'Pick one?',
			options: [
				{ id: 'one', label: 'One' },
				{ id: 'two', label: 'Two' }
			],
			timeoutMs,
			executionSecret: childRun.executionSecret
		});

		return { caller, child, childRun, questionId: question.questionId };
	}

	it.each(['answer_question', 'stop'] as const)(
		'keeps a completed child with a no-expiry question visible until %s',
		async (action) => {
			const t = initConvexTest();
			const { caller, child, childRun, questionId } = await childWithPendingQuestion(t, null);

			await t.mutation(api.agentRuntime.finalizeExecutorRun, {
				runId: child.runId,
				text: 'Waiting for your answer',
				status: 'completed',
				executionSecret: childRun.executionSecret
			});

			const target = {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: child.threadId
			};

			const monitor = await t.mutation(api.subagents.threadMonitorInfo, target);

			expect(monitor.pendingQuestions).toHaveLength(1);
			expect(monitor.pendingQuestions[0]).toMatchObject({ questionId, status: 'pending' });
			expect(monitor.pendingQuestions[0]).not.toHaveProperty('timeoutAt');
			expect(monitor).toMatchObject({
				status: 'completed',
				active: true,
				pendingQuestions: [expect.objectContaining({ questionId })]
			});

			const transcript = await t.run(async (ctx) => {
				const state = await ctx.db
					.query('threadTranscriptStates')
					.withIndex('by_threadId', (q) => q.eq('threadId', child.threadId))
					.unique();

				await ctx.db.patch('threadRecords', child.threadId, {
					contextSummary: 'Prior delegated work',
					contextSummaryThroughPartNumber: 0
				});

				return state!;
			});

			expect((await t.mutation(api.subagents.threadMonitorInfo, target)).transcript).toEqual({
				threadId: child.threadId,
				totalParts: transcript.totalParts,
				historyFromNumber: 1,
				contextSummary: 'Prior delegated work'
			});
			expect(
				await caller.asUser.query(api.threads.subtreeSummaryForThread, {
					threadId: caller.threadId
				})
			).toMatchObject({
				descendantsActive: true,
				descendantStatusCounts: { queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0 }
			});

			const controlled = await t.mutation(api.subagents.control, {
				...target,
				action,
				questionId,
				optionId: 'one'
			});

			if (action === 'answer_question') {
				expect(controlled.answer).toMatchObject({ optionId: 'one', optionLabel: 'One' });
				expect(controlled.continuation).toEqual({ runId: child.runId, prompt: 'One' });
			} else {
				expect(controlled.stoppedRunId).toBe(child.runId);
				expect((await t.run((ctx) => ctx.db.get('agentQuestions', questionId)))?.status).toBe(
					'cancelled'
				);
				await expect(
					t.mutation(api.subagents.control, {
						...target,
						action: 'answer_question',
						questionId,
						optionId: 'one'
					})
				).rejects.toThrow(/no longer awaiting an answer/);
			}

			expect(await t.mutation(api.subagents.threadMonitorInfo, target)).toMatchObject({
				status: 'completed',
				active: false,
				pendingQuestions: []
			});
			expect(
				await caller.asUser.query(api.threads.subtreeSummaryForThread, {
					threadId: caller.threadId
				})
			).toMatchObject({
				descendantsActive: false,
				descendantStatusCounts: { queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0 }
			});
		}
	);

	it('clears ancestor activity when the last question of a completed child times out', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const { caller, child, childRun, questionId } = await childWithPendingQuestion(t);
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: child.runId,
			text: 'Waiting',
			status: 'completed',
			executionSecret: childRun.executionSecret
		});

		const summary = () =>
			caller.asUser.query(api.threads.subtreeSummaryForThread, { threadId: caller.threadId });

		expect(await summary()).toMatchObject({
			workingDescendantCount: 0,
			descendantsActive: true
		});
		vi.setSystemTime(Date.now() + 60_000);
		await t.mutation(internal.agentQuestions.timeout, { questionId });
		expect(await summary()).toMatchObject({
			descendantCount: 1,
			workingDescendantCount: 0,
			descendantsActive: false
		});
		await t.mutation(internal.agentQuestions.timeout, { questionId });
		expect((await summary()).descendantsActive).toBe(false);
	});

	it('parent discovers and answers a child question; first answer wins', async () => {
		const t = initConvexTest();
		const { caller, child, questionId } = await childWithPendingQuestion(t);

		const monitor = await t.mutation(api.subagents.threadMonitorInfo, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: child.threadId
		});

		expect(monitor).toMatchObject({
			status: 'running',
			active: true,
			pendingQuestions: [expect.objectContaining({ questionId })]
		});

		// The human (UI) answers first; the agent's later answer must not overwrite.
		await caller.asUser.mutation(api.agentQuestions.answer, {
			threadId: child.threadId,
			questionId,
			optionId: 'two'
		});

		const second = await t.mutation(api.subagents.control, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: child.threadId,
			action: 'answer_question',
			questionId,
			optionId: 'one'
		});

		expect(second.alreadyAnswered).toBe(true);
		expect(second.answer).toMatchObject({ optionId: 'two' });

		const stored = await t.run((ctx) => ctx.db.get('agentQuestions', questionId));
		expect(stored?.answer).toMatchObject({ optionId: 'two' });
	});

	it('agent answers first; UI sees the committed answer and cannot overwrite', async () => {
		const t = initConvexTest();
		const { caller, child, questionId } = await childWithPendingQuestion(t);

		const answered = await t.mutation(api.subagents.control, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: child.threadId,
			action: 'answer_question',
			questionId,
			optionId: 'one'
		});

		expect(answered.answer).toMatchObject({ optionId: 'one', optionLabel: 'One' });
		expect(answered.alreadyAnswered).toBeUndefined();

		const ui = await caller.asUser.mutation(api.agentQuestions.answer, {
			threadId: child.threadId,
			questionId,
			optionId: 'two'
		});

		expect(ui.question.answer).toMatchObject({ optionId: 'one' });

		const stored = await t.run((ctx) => ctx.db.get('agentQuestions', questionId));
		expect(stored?.answer).toMatchObject({ optionId: 'one' });
	});

	it.each(['tool', 'ui', 'executor'] as const)(
		'%s stop cancels the entire descendant tree and leaves siblings running',
		async (source) => {
			vi.useFakeTimers();
			const t = initConvexTest();
			const caller = await startCallerRun(t);
			const sibling = await createChild(t, caller);
			const childArgs = createArgs(caller);
			const child = await t.mutation(api.subagents.createOrSend, childArgs);
			const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);
			const grandchildArgs = createArgs(childRun);
			const grandchild = await t.mutation(api.subagents.createOrSend, grandchildArgs);
			const grandchildRun = await claimChildRun(t, grandchild, grandchildArgs.childExecutionSecret);

			const greatGrandchild = await t.mutation(
				api.subagents.createOrSend,
				createArgs(grandchildRun)
			);

			const otherGrandchild = await t.mutation(api.subagents.createOrSend, createArgs(childRun));

			if (source === 'tool') {
				const stopped = await t.mutation(api.subagents.control, {
					runId: caller.runId,
					claimId: caller.claimId,
					executionSecret: caller.executionSecret,
					threadId: child.threadId,
					action: 'stop'
				});

				expect(stopped.stoppedRunId).toBe(child.runId);
			} else if (source === 'ui') {
				expect(
					await caller.asUser.mutation(api.agentRuntime.requestCancellation, {
						runId: child.runId
					})
				).toBe(true);
			} else {
				await t.mutation(api.agentRuntime.finalizeExecutorRun, {
					runId: child.runId,
					expectedClaimId: childRun.claimId,
					executionSecret: childRun.executionSecret,
					status: 'cancelled',
					text: ''
				});
			}

			await finishTreeCancellation(t, child.threadId);

			for (const target of [child, grandchild, greatGrandchild, otherGrandchild]) {
				expect(await t.run((ctx) => ctx.db.get('runs', target.runId))).toMatchObject({
					cancellationRequestedAt: expect.any(Number)
				});
			}

			for (const target of [caller, sibling]) {
				expect(
					(await t.run((ctx) => ctx.db.get('runs', target.runId)))?.cancellationRequestedAt
				).toBeUndefined();
			}

			await expect(
				t.mutation(api.subagents.createOrSend, createArgs(grandchildRun))
			).rejects.toThrow(/cancelled/);
			await vi.advanceTimersByTimeAsync(10_000);
			await t.finishInProgressScheduledFunctions();

			for (const target of [child, grandchild, greatGrandchild, otherGrandchild]) {
				expect((await t.run((ctx) => ctx.db.get('runs', target.runId)))?.status).toBe('cancelled');
			}
		}
	);

	it.each(['tool', 'ui'] as const)(
		'%s stop traverses completed children and cancels descendant questions',
		async (source) => {
			vi.useFakeTimers();
			const t = initConvexTest();
			const { caller, child, childRun, questionId } = await childWithPendingQuestion(t);
			const grandchildArgs = createArgs(childRun);
			const grandchild = await t.mutation(api.subagents.createOrSend, grandchildArgs);
			const grandchildRun = await claimChildRun(t, grandchild, grandchildArgs.childExecutionSecret);
			await t.mutation(api.agentRuntime.beginToolJob, {
				runId: grandchild.runId,
				claimId: grandchildRun.claimId,
				executionSecret: grandchildRun.executionSecret,
				...toolTranscriptAssignment(grandchild.runId, grandchildRun.claimId),
				kind: 'ask_question',
				payload: { question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }
			});

			const descendantQuestion = await t.mutation(api.agentQuestions.create, {
				runId: grandchild.runId,
				claimId: grandchildRun.claimId,
				executionSecret: grandchildRun.executionSecret,
				question: 'Continue?',
				options: [{ id: 'yes', label: 'Yes' }]
			});

			const greatGrandchild = await t.mutation(
				api.subagents.createOrSend,
				createArgs(grandchildRun)
			);

			for (const run of [childRun, grandchildRun]) {
				await t.mutation(api.agentRuntime.finalizeExecutorRun, {
					runId: run.runId,
					executionSecret: run.executionSecret,
					status: 'completed',
					text: ''
				});
			}

			if (source === 'tool') {
				await t.mutation(api.subagents.control, {
					runId: caller.runId,
					claimId: caller.claimId,
					executionSecret: caller.executionSecret,
					threadId: child.threadId,
					action: 'stop'
				});
			} else {
				await caller.asUser.mutation(api.agentRuntime.requestCancellation, { runId: child.runId });
			}

			await finishTreeCancellation(t, child.threadId);

			for (const id of [questionId, descendantQuestion.questionId]) {
				expect((await t.run((ctx) => ctx.db.get('agentQuestions', id)))?.status).toBe('cancelled');
			}

			expect(
				(await t.run((ctx) => ctx.db.get('runs', greatGrandchild.runId)))?.cancellationRequestedAt
			).toBeDefined();

			for (const run of [child, grandchild]) {
				expect((await t.run((ctx) => ctx.db.get('runs', run.runId)))?.status).toBe('completed');
			}
		}
	);

	it('stopping an old child run leaves replacement descendants running', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const childArgs = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, childArgs);
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: child.runId,
			executionSecret: childArgs.childExecutionSecret,
			status: 'completed',
			text: ''
		});
		const replacementArgs = createArgs(caller, { threadId: child.threadId });
		const replacement = await t.mutation(api.subagents.createOrSend, replacementArgs);

		const replacementRun = await claimChildRun(
			t,
			replacement,
			replacementArgs.childExecutionSecret
		);

		const grandchild = await t.mutation(api.subagents.createOrSend, createArgs(replacementRun));
		expect(
			await caller.asUser.mutation(api.agentRuntime.requestCancellation, { runId: child.runId })
		).toBe(false);

		for (const run of [replacement, grandchild]) {
			expect(
				(await t.run((ctx) => ctx.db.get('runs', run.runId)))?.cancellationRequestedAt
			).toBeUndefined();
		}
	});

	it('stop on an abandoned child prevents automatic recovery', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const args = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, args);
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: child.runId,
			executionSecret: args.childExecutionSecret,
			text: '',
			status: 'failed',
			lastError: RUN_ABANDONED_BY_AGENT
		});
		const queryArgs = { submissionId: args.submissionId, machineId: machine.machineId };
		expect(await caller.asUser.query(api.runRecovery.state, queryArgs)).toMatchObject({
			state: 'recover'
		});

		const stopArgs = {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: child.threadId,
			action: 'stop' as const
		};

		expect(await t.mutation(api.subagents.control, stopArgs)).toEqual({
			stoppedRunId: child.runId
		});
		const stopped = await t.run((ctx) => ctx.db.get('runs', child.runId));
		expect(stopped?.cancellationRequestedAt).toBeDefined();
		expect(stopped?.status).toBe('failed');
		expect(stopped?.cancellationDeadlineAt).toBeUndefined();
		await t.mutation(api.subagents.control, stopArgs);
		expect(await t.run((ctx) => ctx.db.get('runs', child.runId))).toEqual(stopped);
		expect(await caller.asUser.query(api.runRecovery.state, queryArgs)).toEqual({
			state: 'discard'
		});
		await expect(
			insertQueuedRun(t, caller.asUser, {
				threadId: child.threadId,
				submissionId: `${AUTOMATIC_RECOVERY_SUBMISSION_PREFIX}stopped-child`,
				executionSecret: 'recovery-secret',
				prompt: '',
				machineId: machine.machineId,
				continuationOfRunId: child.runId
			})
		).rejects.toThrow('This run cannot recover automatically.');
	});

	it('observes the stopped run even after replacement work starts', async () => {
		const t = initConvexTest();
		const caller = await startCallerRun(t);

		const credentials = {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret
		};

		const child = await createChild(t, caller);

		const stopped = await t.mutation(api.subagents.control, {
			...credentials,
			threadId: child.threadId,
			action: 'stop'
		});

		await t.run(async (ctx) => {
			await ctx.db.patch('runs', child.runId, { status: 'cancelled' });
			await ctx.db.patch('threadRecords', child.threadId, { status: 'cancelled' });
		});
		await t.mutation(
			api.subagents.createOrSend,
			createArgs(caller, { threadId: child.threadId, prompt: 'Replacement work' })
		);
		const target = { ...credentials, threadId: child.threadId };
		expect(
			await t.mutation(api.subagents.threadMonitorInfo, {
				...target,
				targetRunId: stopped.stoppedRunId
			})
		).toMatchObject({ status: 'cancelled' });
		expect(await t.mutation(api.subagents.threadMonitorInfo, target)).toMatchObject({
			status: 'queued'
		});
		const sibling = await createChild(t, caller);
		await expect(
			t.mutation(api.subagents.threadMonitorInfo, {
				...target,
				targetRunId: sibling.runId
			})
		).rejects.toThrow(/does not belong/);
	});
});

describe('subagents.control delegated answer retries', () => {
	async function completedChildWithQuestion(t: ConvexTestInstance) {
		const caller = await startCallerRun(t);
		const childArgs = createArgs(caller);
		const child = await t.mutation(api.subagents.createOrSend, childArgs);
		const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);

		await t.mutation(api.agentRuntime.beginToolJob, {
			runId: child.runId,
			claimId: childRun.claimId,
			...toolTranscriptAssignment(child.runId, childRun.claimId),
			kind: 'ask_question',
			payload: { question: 'placeholder', options: [{ id: 'a', label: 'A' }] },
			executionSecret: childRun.executionSecret
		});

		const question = await t.mutation(api.agentQuestions.create, {
			runId: child.runId,
			claimId: childRun.claimId,
			question: 'Which region?',
			options: [
				{ id: 'east', label: 'East' },
				{ id: 'west', label: 'West' }
			],
			timeoutMs: 60_000,
			executionSecret: childRun.executionSecret
		});

		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: child.runId,
			text: 'done',
			status: 'completed',
			executionSecret: childRun.executionSecret
		});

		return { caller, child, childRun, questionId: question.questionId };
	}

	async function beginControlJob(
		t: ConvexTestInstance,
		caller: CallerRun,
		targetThreadId: Id<'threadRecords'>,
		questionId: Id<'agentQuestions'>,
		ordinal = 9
	) {
		const job = await t.mutation(api.agentRuntime.beginToolJob, {
			runId: caller.runId,
			claimId: caller.claimId,
			...toolTranscriptAssignment(caller.runId, caller.claimId, ordinal),
			kind: 'control_subagent',
			payload: { threadId: targetThreadId, action: 'answer_question', questionId },
			executionSecret: caller.executionSecret
		});

		return job.jobId;
	}

	function controlArgs(
		caller: CallerRun,
		targetThreadId: Id<'threadRecords'>,
		questionId: Id<'agentQuestions'>,
		toolJobId: Id<'executorJobs'>,
		optionId = 'east'
	) {
		return {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: targetThreadId,
			action: 'answer_question' as const,
			toolJobId,
			questionId,
			optionId
		};
	}

	it('a committed answer is authorized only by its matching answer job', async () => {
		const t = initConvexTest();
		const { caller, child, questionId } = await completedChildWithQuestion(t);
		const other = await completedChildWithQuestion(t);
		const jobId = await beginControlJob(t, caller, child.threadId, questionId);
		const args = controlArgs(caller, child.threadId, questionId, jobId);

		for (const payload of [
			{ threadId: child.threadId, prompt: 'Follow-up' },
			{ threadId: child.threadId, action: 'stop', questionId },
			{ threadId: caller.threadId, action: 'answer_question', questionId },
			{ threadId: child.threadId, action: 'answer_question', questionId: other.questionId }
		]) {
			await t.run((ctx) => ctx.db.patch('executorJobs', jobId, { payload }));
			await expect(t.mutation(api.subagents.control, args)).rejects.toThrow(
				/Invalid subagent control job/
			);
		}

		await t.run((ctx) =>
			ctx.db.patch('executorJobs', jobId, {
				payload: { threadId: child.threadId, action: 'answer_question', questionId }
			})
		);
		const result = await t.mutation(api.subagents.control, args);
		expect(result.answer).toMatchObject({ optionId: 'east', optionLabel: 'East' });
		expect(result.continuation?.prompt).toBe('East');
	});

	it('a lost-response retry under the same live claim reconstructs the committed answer', async () => {
		const t = initConvexTest();
		const { caller, child, questionId } = await completedChildWithQuestion(t);
		const jobId = await beginControlJob(t, caller, child.threadId, questionId);

		const first = await t.mutation(api.subagents.control, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: child.threadId,
			action: 'answer_question',
			toolJobId: jobId,
			questionId,
			optionId: 'east'
		});

		expect(first.alreadyAnswered).toBeUndefined();
		expect(first.answer).toMatchObject({ optionId: 'east', optionLabel: 'East' });
		expect(first.continuation).toMatchObject({ runId: child.runId, prompt: 'East' });

		const retry = await t.mutation(api.subagents.control, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: child.threadId,
			action: 'answer_question',
			toolJobId: jobId,
			questionId,
			optionId: 'west'
		});

		expect(retry.alreadyAnswered).toBe(true);
		expect(retry.answer).toMatchObject({ optionId: 'east' });
		expect(retry.continuation).toEqual(first.continuation);
	});

	it.each([false, true])(
		'a restarted caller preserves the answer and recovers only accepted work (accepted: %s)',
		async (accepted) => {
			const t = initConvexTest();
			const { caller, child, questionId } = await completedChildWithQuestion(t);
			const jobId = await beginControlJob(t, caller, child.threadId, questionId);

			const controlArgs = {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: child.threadId,
				action: 'answer_question' as const,
				toolJobId: jobId,
				questionId,
				optionId: 'east'
			};

			const answered = await t.mutation(api.subagents.control, controlArgs);

			const continuationArgs = createArgs(caller, {
				threadId: child.threadId,
				prompt: answered.continuation!.prompt,
				continuationOfRunId: child.runId,
				continuationQuestionId: questionId
			});

			const queued = accepted
				? await t.mutation(api.subagents.createOrSend, continuationArgs)
				: undefined;

			const claimId = 'restarted-caller-claim';
			await t.run(async (ctx) => {
				const execution = await ctx.db
					.query('runExecutionStates')
					.withIndex('by_runId', (q) => q.eq('runId', caller.runId))
					.unique();

				await ctx.db.patch('runExecutionStates', execution!._id, { claimId });
			});

			const retry = await t.mutation(api.subagents.control, { ...controlArgs, claimId });
			expect(retry.alreadyAnswered).toBe(true);
			expect(retry.answer).toMatchObject({ optionId: 'east', optionLabel: 'East' });
			expect(retry.continuation).toBeUndefined();

			const recovered = await t.mutation(api.subagents.recoverSubmission, {
				runId: caller.runId,
				claimId,
				executionSecret: caller.executionSecret,
				submissionId: continuationArgs.submissionId,
				childExecutionSecret: continuationArgs.childExecutionSecret
			});

			if (queued) {
				expect(recovered).toMatchObject({ runId: queued.runId, prompt: 'East' });

				const duplicate = await t.mutation(api.subagents.createOrSend, {
					...continuationArgs,
					claimId
				});

				expect(duplicate).toMatchObject({ runId: queued.runId });
			} else {
				expect(recovered).toBeNull();
				await expect(
					t.mutation(api.subagents.createOrSend, { ...continuationArgs, claimId })
				).rejects.toThrow(/Question continuation is no longer available/);
			}

			const runs = await t.run((ctx) =>
				ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', child.threadId))
					.collect()
			);

			expect(runs).toHaveLength(accepted ? 2 : 1);
		}
	);

	it('a different job id or a UI answer does not replay the continuation', async () => {
		const t = initConvexTest();
		const { caller, child, questionId } = await completedChildWithQuestion(t);
		const jobId = await beginControlJob(t, caller, child.threadId, questionId);

		await t.mutation(api.subagents.control, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: child.threadId,
			action: 'answer_question',
			toolJobId: jobId,
			questionId,
			optionId: 'east'
		});

		const otherJobId = await beginControlJob(t, caller, child.threadId, questionId, 10);

		const duplicate = await t.mutation(api.subagents.control, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: child.threadId,
			action: 'answer_question',
			toolJobId: otherJobId,
			questionId,
			optionId: 'east'
		});

		expect(duplicate.alreadyAnswered).toBe(true);
		expect(duplicate.answer).toMatchObject({ optionId: 'east' });
		expect(duplicate.continuation).toBeUndefined();

		const ui = await caller.asUser.mutation(api.agentQuestions.answer, {
			threadId: child.threadId,
			questionId,
			optionId: 'east'
		});

		expect(ui.question.answer).toMatchObject({ optionId: 'east' });
		expect(ui.continuation).toBeUndefined();
	});

	it('rejects a tool job bound to another run, thread, or a non-control kind', async () => {
		const t = initConvexTest();
		const { caller, child, questionId } = await completedChildWithQuestion(t);

		const otherCaller = await startCallerRun(t);
		const foreignJobId = await beginControlJob(t, otherCaller, child.threadId, questionId, 11);
		await expect(
			t.mutation(api.subagents.control, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: child.threadId,
				action: 'answer_question',
				toolJobId: foreignJobId,
				questionId,
				optionId: 'east'
			})
		).rejects.toThrow(/Invalid subagent control job/);

		const execJob = await t.mutation(api.agentRuntime.beginToolJob, {
			runId: caller.runId,
			claimId: caller.claimId,
			...toolTranscriptAssignment(caller.runId, caller.claimId, 12),
			kind: 'exec_command',
			payload: { cmd: 'echo hi' },
			executionSecret: caller.executionSecret
		});

		await expect(
			t.mutation(api.subagents.control, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: child.threadId,
				action: 'answer_question',
				toolJobId: execJob.jobId,
				questionId,
				optionId: 'east'
			})
		).rejects.toThrow(/Invalid subagent control job/);

		const stored = await t.run((ctx) => ctx.db.get('agentQuestions', questionId));
		expect(stored?.status).toBe('pending');
	});

	it('queued continuation from the answer retried with the same submission and secret creates no duplicate run or prompt', async () => {
		const t = initConvexTest();
		const { caller, child, questionId } = await completedChildWithQuestion(t);
		const jobId = await beginControlJob(t, caller, child.threadId, questionId);

		const answered = await t.mutation(api.subagents.control, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			threadId: child.threadId,
			action: 'answer_question',
			toolJobId: jobId,
			questionId,
			optionId: 'west',
			text: 'Use the west cluster'
		});

		expect(answered.continuation).toMatchObject({
			runId: child.runId,
			prompt: 'West: Use the west cluster'
		});

		const continuationArgs = createArgs(caller, {
			threadId: child.threadId,
			prompt: answered.continuation!.prompt,
			submissionId: 'continuation-submission-1',
			childExecutionSecret: 'continuation-secret-1',
			continuationOfRunId: answered.continuation!.runId,
			continuationQuestionId: questionId
		});

		const queued = await t.mutation(api.subagents.createOrSend, continuationArgs);
		expect(queued.threadId).toBe(child.threadId);
		expect(queued.continuationOfRunId).toBe(child.runId);

		const retried = await t.mutation(api.subagents.createOrSend, continuationArgs);
		expect(retried.runId).toBe(queued.runId);
		expect(retried.threadId).toBe(child.threadId);

		const parts = await t.run(async (ctx) =>
			ctx.db
				.query('threadTranscriptParts')
				.withIndex('by_threadId_and_number', (q) => q.eq('threadId', child.threadId))
				.collect()
		);

		const prompts = parts.filter((part) => part.prompt);
		expect(prompts).toHaveLength(2);
		expect(prompts[1].prompt?.text).toBe('West: Use the west cluster');

		await caller.asUser.mutation(api.agentRuntime.requestCancellation, { runId: queued.runId });
		const stoppedRetry = await t.mutation(api.subagents.createOrSend, continuationArgs);
		expect(stoppedRetry).toMatchObject({ runId: queued.runId });

		const recovered = await t.mutation(api.subagents.recoverSubmission, {
			runId: caller.runId,
			claimId: caller.claimId,
			executionSecret: caller.executionSecret,
			submissionId: continuationArgs.submissionId,
			childExecutionSecret: continuationArgs.childExecutionSecret
		});

		expect(recovered).toMatchObject({ runId: queued.runId });
		expect(
			await t.mutation(api.agentRuntime.start, {
				runId: queued.runId,
				claimId: 'stopped-child-claim',
				executionSecret: continuationArgs.childExecutionSecret
			})
		).toMatchObject({ claimed: false });
	});

	it.each([
		{
			name: 'native control stop',
			stop: async (
				t: ConvexTestInstance,
				caller: CallerRun,
				child: { threadId: Id<'threadRecords'>; runId: Id<'runs'> }
			) => {
				await t.mutation(api.subagents.control, {
					runId: caller.runId,
					claimId: caller.claimId,
					executionSecret: caller.executionSecret,
					threadId: child.threadId,
					action: 'stop'
				});
			}
		},
		{
			name: 'UI run-bound Stop',
			stop: async (
				t: ConvexTestInstance,
				caller: CallerRun,
				child: { threadId: Id<'threadRecords'>; runId: Id<'runs'> }
			) => {
				await caller.asUser.mutation(api.agentRuntime.requestCancellation, { runId: child.runId });
			}
		}
	])(
		'stop between committed answer and queue keeps the answer but voids the continuation ($name)',
		async ({ stop }) => {
			const t = initConvexTest();
			const { caller, child, questionId } = await completedChildWithQuestion(t);
			const jobId = await beginControlJob(t, caller, child.threadId, questionId);

			const answered = await t.mutation(api.subagents.control, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: child.threadId,
				action: 'answer_question',
				toolJobId: jobId,
				questionId,
				optionId: 'east'
			});

			expect(answered.continuation).toMatchObject({ runId: child.runId, prompt: 'East' });

			// Stop lands after the answer committed but before the continuation queued.
			await stop(t, caller, child);

			const stored = await t.run((ctx) => ctx.db.get('agentQuestions', questionId));
			expect(stored?.status).toBe('answered');
			expect(stored?.answer).toMatchObject({ optionId: 'east' });

			const retry = await t.mutation(api.subagents.control, {
				runId: caller.runId,
				claimId: caller.claimId,
				executionSecret: caller.executionSecret,
				threadId: child.threadId,
				action: 'answer_question',
				toolJobId: jobId,
				questionId,
				optionId: 'east'
			});

			expect(retry.alreadyAnswered).toBe(true);
			expect(retry.answer).toMatchObject({ optionId: 'east' });
			expect(retry.continuation).toBeUndefined();

			await expect(
				t.mutation(
					api.subagents.createOrSend,
					createArgs(caller, {
						threadId: child.threadId,
						prompt: 'East',
						submissionId: 'stale-continuation-submission',
						childExecutionSecret: 'stale-continuation-secret',
						continuationOfRunId: answered.continuation!.runId,
						continuationQuestionId: questionId
					})
				)
			).rejects.toThrow(/Question continuation is no longer available/);

			const runs = await t.run(async (ctx) =>
				ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', child.threadId))
					.collect()
			);

			expect(runs).toHaveLength(1);

			const parts = await t.run(async (ctx) =>
				ctx.db
					.query('threadTranscriptParts')
					.withIndex('by_threadId_and_number', (q) => q.eq('threadId', child.threadId))
					.collect()
			);

			expect(parts.filter((part) => part.prompt)).toHaveLength(1);
		}
	);
});

describe('subagents task deadline', () => {
	it('a task deadline also stops descendant work', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const childArgs = createArgs(caller, { timeoutMs: 30_000 });
		const child = await t.mutation(api.subagents.createOrSend, childArgs);
		const childRun = await claimChildRun(t, child, childArgs.childExecutionSecret);
		const grandchild = await t.mutation(api.subagents.createOrSend, createArgs(childRun));
		await vi.advanceTimersByTimeAsync(30_001);
		await t.finishInProgressScheduledFunctions();
		expect((await t.run((ctx) => ctx.db.get('runs', child.runId)))?.status).toBe('cancelled');
		expect(
			(await t.run((ctx) => ctx.db.get('runs', grandchild.runId)))?.cancellationRequestedAt
		).toBeDefined();
	});

	it('A completes before its deadline, B starts running, then A deadline is a no-op', async () => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const caller = await startCallerRun(t);

		const taskAArgs = createArgs(caller, { timeoutMs: 30_000 });
		const taskA = await t.mutation(api.subagents.createOrSend, taskAArgs);

		const runA = await claimChildRun(t, taskA, taskAArgs.childExecutionSecret);
		await t.mutation(api.agentRuntime.finalizeExecutorRun, {
			runId: taskA.runId,
			text: 'done',
			status: 'completed',
			executionSecret: runA.executionSecret
		});

		const taskBArgs = createArgs(caller, { threadId: taskA.threadId, prompt: 'Second task' });
		const taskB = await t.mutation(api.subagents.createOrSend, taskBArgs);
		await claimChildRun(t, taskB, taskBArgs.childExecutionSecret, 'claim-b');

		await vi.advanceTimersByTimeAsync(31_000);

		const [aDoc, bDoc] = await t.run(async (ctx) =>
			Promise.all([ctx.db.get('runs', taskA.runId), ctx.db.get('runs', taskB.runId)])
		);

		expect(aDoc?.status).toBe('completed');
		expect(bDoc?.status).toBe('running');
		expect(bDoc?.cancellationRequestedAt).toBeUndefined();
	});

	it.each([30_000, 0])('cancels the bound execution after a %i ms timeout', async (timeoutMs) => {
		vi.useFakeTimers();
		const t = initConvexTest();
		const caller = await startCallerRun(t);
		const timed = await t.mutation(api.subagents.createOrSend, createArgs(caller, { timeoutMs }));
		const deadlineMs = Math.max(1, timeoutMs);

		await vi.advanceTimersByTimeAsync(deadlineMs - 1);
		expect((await t.run((ctx) => ctx.db.get('runs', timed.runId)))?.status).toBe('queued');

		await vi.advanceTimersByTimeAsync(2);
		const expired = await t.run((ctx) => ctx.db.get('runs', timed.runId));
		expect(expired?.status).toBe('cancelled');
		expect(expired?.lastError).toMatch(/deadline/);
	});
});
