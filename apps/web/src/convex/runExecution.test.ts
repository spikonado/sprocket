import { describe, expect, it, vi } from 'vitest';
import { api } from '@convex/_generated/api';
import type { MutationCtx } from '@convex/_generated/server';
import type { Infer } from 'convex/values';
import type { vCommandExecResult } from '@convex/lib/validators';
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
import {
	createQueuedRun,
	initConvexTest,
	seedOwnedThread,
	toolTranscriptAssignment
} from './test.setup';

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
	it.each([
		{ kind: 'exec_command' as const, running: false },
		{ kind: 'exec_command' as const, running: true },
		{ kind: 'write_stdin' as const, running: false },
		{ kind: 'write_stdin' as const, running: true }
	])('records $kind results with running=$running', async ({ kind, running }) => {
		const { t, asUser, threadId, auth } = await startedRun();
		const callId = 'command-call';
		const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
			...auth,
			...toolTranscriptAssignment(auth.runId, auth.claimId),
			kind,
			callId,
			payload: kind === 'exec_command' ? { cmd: 'echo ok' } : { sessionId: '1' }
		});
		const output: Infer<typeof vCommandExecResult> = {
			output: 'ok\n',
			success: !running,
			running,
			timedOut: false,
			completeLogPath: '/transcripts/command/output.log',
			eventsPath: '/transcripts/command/events.jsonl'
		};
		if (!running) output.exitCode = 0;
		if (kind === 'exec_command' && running) output.sessionId = '1';
		const result =
			kind === 'write_stdin' ? { ...output, command: 'echo ok', workdir: '/' } : output;
		expect(await asUser.mutation(api.executor.complete, { ...auth, jobId, result })).toBe(true);
		expect(
			await asUser.query(api.executor.getJob, {
				runId: auth.runId,
				executionSecret: auth.executionSecret,
				jobId
			})
		).toEqual({
			jobId,
			status: 'completed',
			result
		});
		await t.run(async (ctx) => {
			expect((await getRunWithExecution(ctx.db, auth.runId))?.activeJobId).toBeUndefined();
		});
		const { parts } = await asUser.query(api.transcript.getParts, {
			threadId,
			numbers: [0, 1, 2]
		});
		expect(parts.filter((part) => part.kind === 'tool').map((part) => part.tool)).toEqual([
			expect.objectContaining({ callId, name: kind, status: 'started' }),
			expect.objectContaining({ callId, name: kind, status: 'completed', output: result })
		]);
	});

	it('still accepts command results from older executors', async () => {
		const { asUser, auth } = await startedRun();
		const { jobId } = await asUser.mutation(api.agentRuntime.beginToolJob, {
			...auth,
			...toolTranscriptAssignment(auth.runId, auth.claimId),
			kind: 'exec_command',
			payload: { cmd: 'echo ok' }
		});
		const result = {
			command: 'echo ok',
			cwd: '/',
			exitCode: 0,
			success: true,
			running: false,
			timedOut: false,
			output: 'ok\n',
			truncated: false
		};
		expect(await asUser.mutation(api.executor.complete, { ...auth, jobId, result })).toBe(true);
		expect(
			await asUser.query(api.executor.getJob, {
				runId: auth.runId,
				executionSecret: auth.executionSecret,
				jobId
			})
		).toEqual({ jobId, status: 'completed', result });
	});

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
				...toolTranscriptAssignment(auth.runId, auth.claimId, 1, 1),
				kind: 'exec_command',
				payload: { cmd: 'true' }
			});
			const second = await callHandler(api.agentRuntime.beginToolJob, beginToolJob, ctx, {
				...auth,
				...toolTranscriptAssignment(auth.runId, auth.claimId, 2, 1),
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
			...toolTranscriptAssignment(auth.runId, auth.claimId),
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
