import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { initConvexTest, seedOwnedThread, type ConvexTestInstance } from './test.setup';

async function seedRunWithJob(
	t: ConvexTestInstance,
	options: {
		executionSecret: string;
		runStatus?: 'queued' | 'running' | 'awaiting_executor' | 'failed' | 'completed';
		jobStatus?: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
		activeJobMatches?: boolean;
		claimId?: string;
		claimExpiresAt?: number;
	}
) {
	const executionSecret = options.executionSecret;
	const claimId = options.claimId ?? `claim-${Math.random()}`;
	const { asUser, threadId, workspaceSessionId, subject } = await seedOwnedThread(t);
	const created = await asUser.mutation(api.agentRuntime.createRun, {
		submissionId: `sub-job-${Math.random()}`,
		threadId,
		prompt: 'Use a tool',
		imageUploadIds: [],
		selectedModel: 'gpt-5.6-sol',
		reasoningEffort: 'medium',
		serviceTier: 'standard',
		executionSecret
	});

	const jobId = await t.run(async (ctx) => {
		const jobId = await ctx.db.insert('executorJobs', {
			workspaceSessionId,
			threadId,
			runId: created.runId,
			kind: 'exec_command',
			payload: { cmd: 'echo hi' },
			hidden: false,
			status: options.jobStatus ?? 'claimed',
			enqueuedAt: Date.now(),
			claimedAt: Date.now(),
			sequence: 0
		});
		const otherJobId = await ctx.db.insert('executorJobs', {
			workspaceSessionId,
			threadId,
			runId: created.runId,
			kind: 'exec_command',
			payload: { cmd: 'echo other' },
			hidden: false,
			status: 'pending',
			enqueuedAt: Date.now(),
			sequence: 1
		});
		await ctx.db.patch(created.runId, {
			status: options.runStatus ?? 'awaiting_executor',
			claimId,
			claimExpiresAt: options.claimExpiresAt ?? Date.now() + 60_000,
			activeJobId: options.activeJobMatches === false ? otherJobId : (jobId as Id<'executorJobs'>)
		});
		return jobId;
	});

	return { asUser, subject, runId: created.runId, jobId, claimId, executionSecret };
}

const commandResult = {
	command: 'echo hi',
	cwd: '/',
	exitCode: 0,
	success: true,
	running: false,
	timedOut: false,
	stdout: 'hi',
	stderr: '',
	output: 'hi',
	truncated: false
};

describe('executor', () => {
	it('completes the active job and releases the run back to running', async () => {
		const t = initConvexTest();
		const { asUser, runId, jobId, claimId, executionSecret } = await seedRunWithJob(t, {
			executionSecret: 'executor-complete-secret'
		});

		await expect(
			asUser.mutation(api.executor.complete, {
				jobId,
				result: commandResult,
				runId,
				claimId,
				executionSecret
			})
		).resolves.toBe(true);

		const state = await t.run(async (ctx) => ({
			job: await ctx.db.get(jobId),
			run: await ctx.db.get(runId)
		}));
		expect(state.job).toMatchObject({
			status: 'completed',
			result: commandResult
		});
		expect(state.job?.completedAt).toBeTypeOf('number');
		expect(state.run?.status).toBe('running');
		expect(state.run?.activeJobId ?? undefined).toBeUndefined();
	});

	it('is idempotent for an already completed job and ignores terminal runs', async () => {
		const t = initConvexTest();
		const { asUser, runId, jobId, claimId, executionSecret } = await seedRunWithJob(t, {
			jobStatus: 'completed',
			runStatus: 'running',
			executionSecret: 'executor-idempotent-secret'
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(jobId, { result: commandResult, completedAt: 1 });
		});

		await expect(
			asUser.mutation(api.executor.complete, {
				jobId,
				result: commandResult,
				runId,
				claimId,
				executionSecret
			})
		).resolves.toBe(true);

		const {
			asUser: asUser2,
			runId: terminalRunId,
			jobId: terminalJobId,
			claimId: terminalClaimId,
			executionSecret: terminalSecret
		} = await seedRunWithJob(t, {
			runStatus: 'completed',
			executionSecret: 'executor-terminal-secret'
		});
		await expect(
			asUser2.mutation(api.executor.complete, {
				jobId: terminalJobId,
				result: commandResult,
				runId: terminalRunId,
				claimId: terminalClaimId,
				executionSecret: terminalSecret
			})
		).resolves.toBe(false);
		expect(await t.run(async (ctx) => (await ctx.db.get(terminalRunId))?.status)).toBe('completed');
		expect(await t.run(async (ctx) => (await ctx.db.get(runId))?.status)).toBe('running');
	});

	it('fails a job and clears activeJobId only when it matches', async () => {
		const t = initConvexTest();
		const matching = await seedRunWithJob(t, {
			activeJobMatches: true,
			executionSecret: 'executor-fail-match-secret'
		});
		await expect(
			matching.asUser.mutation(api.executor.fail, {
				jobId: matching.jobId,
				error: 'boom',
				runId: matching.runId,
				claimId: matching.claimId,
				executionSecret: matching.executionSecret
			})
		).resolves.toBe(true);
		expect(
			await t.run(async (ctx) => ({
				job: await ctx.db.get(matching.jobId),
				run: await ctx.db.get(matching.runId)
			}))
		).toMatchObject({
			job: { status: 'failed', error: 'boom' },
			run: { status: 'running' }
		});
		expect(
			(await t.run(async (ctx) => (await ctx.db.get(matching.runId))?.activeJobId)) ?? undefined
		).toBeUndefined();

		const mismatched = await seedRunWithJob(t, {
			activeJobMatches: false,
			executionSecret: 'executor-fail-mismatch-secret'
		});
		const before = await t.run(async (ctx) => ctx.db.get(mismatched.runId));
		await expect(
			mismatched.asUser.mutation(api.executor.fail, {
				jobId: mismatched.jobId,
				error: 'boom',
				runId: mismatched.runId,
				claimId: mismatched.claimId,
				executionSecret: mismatched.executionSecret
			})
		).resolves.toBe(true);
		const after = await t.run(async (ctx) => ctx.db.get(mismatched.runId));
		expect(after?.status).toBe(before?.status);
		expect(after?.activeJobId).toBe(before?.activeJobId);
		expect(await t.run(async (ctx) => (await ctx.db.get(mismatched.jobId))?.status)).toBe('failed');
	});

	it('rejects tool completion and failure after the claim lease expires', async () => {
		const t = initConvexTest();
		const completeCase = await seedRunWithJob(t, {
			executionSecret: 'executor-expired-complete-secret',
			claimExpiresAt: Date.now() - 1
		});
		await expect(
			completeCase.asUser.mutation(api.executor.complete, {
				jobId: completeCase.jobId,
				result: commandResult,
				runId: completeCase.runId,
				claimId: completeCase.claimId,
				executionSecret: completeCase.executionSecret
			})
		).resolves.toBe(false);
		expect(
			await t.run(async (ctx) => ({
				jobStatus: (await ctx.db.get(completeCase.jobId))?.status,
				activeJobId: (await ctx.db.get(completeCase.runId))?.activeJobId
			}))
		).toEqual({ jobStatus: 'claimed', activeJobId: completeCase.jobId });

		const failCase = await seedRunWithJob(t, {
			executionSecret: 'executor-expired-fail-secret',
			claimExpiresAt: Date.now() - 1
		});
		await expect(
			failCase.asUser.mutation(api.executor.fail, {
				jobId: failCase.jobId,
				error: 'late tool failure',
				runId: failCase.runId,
				claimId: failCase.claimId,
				executionSecret: failCase.executionSecret
			})
		).resolves.toBe(false);
		expect(
			await t.run(async (ctx) => ({
				jobStatus: (await ctx.db.get(failCase.jobId))?.status,
				activeJobId: (await ctx.db.get(failCase.runId))?.activeJobId
			}))
		).toEqual({ jobStatus: 'claimed', activeJobId: failCase.jobId });
	});
});
