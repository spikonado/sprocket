import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '@convex/_generated/api';
import type { MutationCtx } from '@convex/_generated/server';
import type {
	FunctionArgs,
	FunctionReference,
	FunctionReturnType,
	RegisteredMutation,
	RegisteredQuery
} from 'convex/server';
import {
	beginToolJob,
	isFinished,
	registerCompletionAttempt,
	renewClaim,
	start
} from '@convex/agentRuntime';
import { selectedThreadLifecycle } from '@convex/chat';
import { complete, fail, getJob } from '@convex/executor';
import {
	getRunWithExecution,
	migrateRunExecution,
	patchRunExecution
} from '@convex/lib/runExecution';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

function callHandler<Ref extends FunctionReference<'query' | 'mutation'>>(
	_reference: Ref,
	registered:
		| RegisteredMutation<'public', FunctionArgs<Ref>, Promise<FunctionReturnType<Ref>>>
		| RegisteredQuery<'public', FunctionArgs<Ref>, Promise<FunctionReturnType<Ref>>>,
	ctx: MutationCtx,
	args: FunctionArgs<Ref>
): Promise<FunctionReturnType<Ref>> {
	// SAFETY: Convex retains _handler at runtime. Calling it inside t.run lets
	// these tests inspect database dependencies on the actual transaction context.
	const { _handler } = registered as typeof registered & {
		_handler: (ctx: MutationCtx, args: FunctionArgs<Ref>) => Promise<FunctionReturnType<Ref>>;
	};
	return _handler(ctx, args);
}

async function startedRun() {
	const t = initConvexTest();
	const { asUser, threadId } = await seedOwnedThread(t);
	const executionSecret = 'execution-state-secret';
	const { runId } = await createQueuedRun(t, asUser, threadId, 'execution-state', executionSecret);
	const auth = { runId, executionSecret, claimId: 'execution-claim' };
	await asUser.mutation(api.agentRuntime.start, auth);
	return { t, asUser, threadId, auth };
}

describe('run execution state', () => {
	it('does not write subscribed run or thread records during tools, attempts, or renewals', async () => {
		const { t, asUser, threadId, auth } = await startedRun();
		await t.run(async (ctx) => {
			const patch = vi.spyOn(ctx.db, 'patch');
			await callHandler(api.agentRuntime.start, start, ctx, auth);
			await callHandler(api.agentRuntime.renewClaim, renewClaim, ctx, auth);
			await callHandler(
				api.agentRuntime.registerCompletionAttempt,
				registerCompletionAttempt,
				ctx,
				{ ...auth, attemptSeq: 1 }
			);
			const first = await callHandler(api.agentRuntime.beginToolJob, beginToolJob, ctx, {
				...auth,
				kind: 'exec_command',
				payload: { cmd: 'true' }
			});
			const second = await callHandler(api.agentRuntime.beginToolJob, beginToolJob, ctx, {
				...auth,
				kind: 'exec_command',
				payload: { cmd: 'false' }
			});
			expect(
				await callHandler(api.executor.complete, complete, ctx, {
					...auth,
					jobId: first.jobId,
					result: {
						command: 'true',
						cwd: '/',
						exitCode: 0,
						success: true,
						running: false,
						timedOut: false,
						output: '',
						truncated: false
					}
				})
			).toBe(true);
			expect((await getRunWithExecution(ctx.db, auth.runId))?.activeJobId).toBe(second.jobId);
			expect(
				await callHandler(api.executor.fail, fail, ctx, {
					...auth,
					jobId: second.jobId,
					error: 'failed'
				})
			).toBe(true);
			await callHandler(
				api.agentRuntime.registerCompletionAttempt,
				registerCompletionAttempt,
				ctx,
				{ ...auth, attemptSeq: 2 }
			);
			expect((await getRunWithExecution(ctx.db, auth.runId))?.activeJobId).toBeUndefined();
			expect(
				patch.mock.calls.some(([table]) => table === 'runs' || table === 'threadRecords')
			).toBe(false);
			expect((await ctx.db.get('runs', auth.runId))?.status).toBe('running');
			expect((await ctx.db.get('threadRecords', threadId))?.status).toBe('running');
		});

		const queryArgs = { runId: auth.runId, executionSecret: auth.executionSecret };
		expect(await asUser.query(api.agentRuntime.isFinished, queryArgs)).toBe(false);
		await asUser.mutation(api.agentRuntime.requestCancellation, { runId: auth.runId });
		expect(await asUser.query(api.agentRuntime.isFinished, queryArgs)).toBe(true);
		expect((await asUser.query(api.chat.selectedThreadLifecycle, { threadId })).phase).toBe(
			'cancellation_requested'
		);
		await expect(
			asUser.query(api.agentRuntime.isFinished, {
				...queryArgs,
				executionSecret: 'wrong-secret'
			})
		).rejects.toThrow('Run not found.');
	});

	it('keeps cancellation, lifecycle, and job subscriptions off execution state', async () => {
		const { asUser, threadId, auth } = await startedRun();
		const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
			...auth,
			kind: 'exec_command',
			payload: { cmd: 'true' }
		});
		await asUser.run(async (ctx) => {
			const query = vi.spyOn(ctx.db, 'query');
			const get = vi.spyOn(ctx.db, 'get');
			expect(await callHandler(api.agentRuntime.isFinished, isFinished, ctx, auth)).toBe(false);
			expect(
				(
					await callHandler(api.chat.selectedThreadLifecycle, selectedThreadLifecycle, ctx, {
						threadId
					})
				).phase
			).toBe('running');
			expect(
				(await callHandler(api.executor.getJob, getJob, ctx, { ...auth, jobId }))?.status
			).toBe('claimed');
			expect(query.mock.calls.some(([table]) => table === 'runExecutionStates')).toBe(false);
			expect(get.mock.calls.some(([table]) => table === 'runExecutionStates')).toBe(false);
		});
	});

	it('automatically backfills live legacy runs without losing claims or active jobs', async () => {
		vi.useFakeTimers();
		try {
			const { t, asUser, threadId, auth } = await startedRun();
			const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
				...auth,
				kind: 'exec_command',
				payload: { cmd: 'true' }
			});
			const expiresAt = Date.now() + 120_000;
			await t.run(async (ctx) => {
				const state = await ctx.db
					.query('runExecutionStates')
					.withIndex('by_runId', (q) => q.eq('runId', auth.runId))
					.unique();
				if (!state) throw new Error('Missing execution state.');
				await ctx.db.delete('runExecutionStates', state._id);
				await ctx.db.patch('runs', auth.runId, {
					status: 'awaiting_executor',
					claimId: auth.claimId,
					claimExpiresAt: expiresAt,
					completionAttemptSeq: 7,
					activeJobId: jobId
				});
				await ctx.db.patch('threadRecords', threadId, { status: 'awaiting_executor' });
			});
			const queryArgs = { runId: auth.runId, executionSecret: auth.executionSecret };
			expect(
				(await asUser.query(api.agentRuntime.completionActor, queryArgs)).completionAttemptSeq
			).toBe(7);
			await t.mutation(internal.migrations.runExecutionBackfillAutomatically, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await t.mutation(internal.migrations.runExecutionBackfillAutomatically, {});
			await t.run(async (ctx) => {
				const run = await ctx.db.get('runs', auth.runId);
				expect(run?.status).toBe('running');
				for (const field of ['claimId', 'claimExpiresAt', 'completionAttemptSeq', 'activeJobId']) {
					expect(run).not.toHaveProperty(field);
				}
				expect((await ctx.db.get('threadRecords', threadId))?.status).toBe('running');
			});
			expect((await asUser.query(api.agentRuntime.getContext, queryArgs)).run).toMatchObject({
				status: 'running',
				claimId: auth.claimId,
				claimExpiresAt: expiresAt,
				completionAttemptSeq: 7,
				activeJobId: jobId
			});
			await expect(
				asUser.mutation(api.agentRuntime.registerCompletionAttempt, {
					...auth,
					attemptSeq: 7
				})
			).rejects.toThrow();
			await asUser.mutation(api.agentRuntime.registerCompletionAttempt, { ...auth, attemptSeq: 8 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps execution state authoritative when a backfill encounters legacy copies', async () => {
		const { t, auth } = await startedRun();
		await t.run(async (ctx) => {
			await patchRunExecution(ctx, auth.runId, {
				completionAttemptSeq: 9,
				claimExpiresAt: undefined
			});
			await ctx.db.patch('runs', auth.runId, {
				claimId: 'obsolete',
				claimExpiresAt: Date.now() + 120_000,
				completionAttemptSeq: 1
			});
			const run = await ctx.db.get('runs', auth.runId);
			if (!run) throw new Error('Missing run.');
			await migrateRunExecution(ctx, run);
			await migrateRunExecution(ctx, run);
			expect(await getRunWithExecution(ctx.db, auth.runId)).toMatchObject({
				claimId: auth.claimId,
				completionAttemptSeq: 9,
				claimExpiresAt: undefined
			});
			expect(
				await ctx.db
					.query('runExecutionStates')
					.withIndex('by_runId', (q) => q.eq('runId', auth.runId))
					.take(2)
			).toHaveLength(1);
		});
		await expect(t.mutation(api.agentRuntime.renewClaim, auth)).resolves.toEqual({
			renewed: false
		});
	});

	it('moves legacy fields on the first execution write without resetting the attempt', async () => {
		const t = initConvexTest();
		const { threadId } = await seedOwnedThread(t);
		await t.run(async (ctx) => {
			const run = await ctx.db
				.query('runs')
				.withIndex('by_threadId_startedAt', (q) => q.eq('threadId', threadId))
				.unique();
			if (!run) throw new Error('Missing legacy run.');
			await ctx.db.patch('runs', run._id, { claimId: 'legacy', completionAttemptSeq: 3 });
			await patchRunExecution(ctx, run._id, { claimExpiresAt: 123 });
			expect(await getRunWithExecution(ctx.db, run._id)).toMatchObject({
				claimId: 'legacy',
				completionAttemptSeq: 3,
				claimExpiresAt: 123
			});
			expect(await ctx.db.get('runs', run._id)).not.toHaveProperty('claimId');
			expect(await ctx.db.get('runs', run._id)).not.toHaveProperty('completionAttemptSeq');
		});
	});
});
