import { describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
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
	getContext,
	isFinished,
	registerCompletionAttempt,
	renewClaim,
	start
} from '@convex/agentRuntime';
import { selectedThreadLifecycle } from '@convex/chat';
import { complete, fail, getJob } from '@convex/executor';
import { getRunWithExecution, patchRunExecution } from '@convex/lib/runExecution';
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
	it('does not write subscribed run or thread records during execution updates', async () => {
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
			const context = await callHandler(api.agentRuntime.getContext, getContext, ctx, auth);
			expect(context.run._id).toBe(auth.runId);
			expect(Object.keys(context.run).sort()).toEqual([
				'_id',
				'continuationOfRunId',
				'fastMode',
				'reasoningEffort',
				'selectedModel',
				'startedAt',
				'threadId',
				'userId'
			]);
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

	it('fails instead of recreating a missing execution state', async () => {
		const { t, auth } = await startedRun();
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query('runExecutionStates')
				.withIndex('by_runId', (query) => query.eq('runId', auth.runId))
				.unique();
			if (!state) throw new Error('Missing execution state fixture.');
			await ctx.db.delete('runExecutionStates', state._id);

			await expect(getRunWithExecution(ctx.db, auth.runId)).rejects.toThrow(
				'Run execution state not found.'
			);
			await expect(patchRunExecution(ctx, auth.runId, { completionAttemptSeq: 2 })).rejects.toThrow(
				'Run execution state not found.'
			);
		});
	});
});
