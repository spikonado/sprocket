import { mutation } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getExecutionRun } from '@convex/lib/auth';
import { executorFailureRunPatch } from '@convex/lib/runs';
import { isRunFinalStatus, vExecutorJobResult } from '@convex/lib/validators';

export const complete = mutation({
	args: {
		jobId: v.id('executorJobs'),
		result: vExecutorJobResult,
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job || job.runId !== args.runId) throw new Error('Executor job not found.');
		const run = await getExecutionRun(ctx, job.runId, args.executionSecret);
		if (job.status === 'cancelled' || job.status === 'failed') {
			return false;
		}
		if (job.status === 'completed') {
			return true;
		}
		if (isRunFinalStatus(run.status)) {
			return false;
		}

		await ctx.db.patch(args.jobId, {
			status: 'completed',
			result: args.result,
			completedAt: Date.now()
		});
		if (run.activeJobId === args.jobId) {
			await ctx.db.patch(run._id, {
				status: 'running',
				activeJobId: undefined
			});
		}
		return true;
	}
});

export const fail = mutation({
	args: {
		jobId: v.id('executorJobs'),
		error: v.string(),
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	handler: async (ctx, args) => {
		const job = await ctx.db.get(args.jobId);
		if (!job || job.runId !== args.runId) throw new Error('Executor job not found.');
		const run = await getExecutionRun(ctx, job.runId, args.executionSecret);
		if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
			return false;
		}

		const completedAt = Date.now();
		await ctx.db.patch(args.jobId, {
			status: 'failed',
			error: args.error,
			completedAt
		});
		const runPatch = executorFailureRunPatch({
			runStatus: run.status,
			activeJobId: run.activeJobId,
			failedJobId: args.jobId
		});
		if (runPatch) {
			await ctx.db.patch(job.runId, runPatch);
		}
		return true;
	}
});
