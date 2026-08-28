import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import type { Infer } from 'convex/values';
import { getExecutionRun } from '@convex/lib/auth';
import { applyExecutorJobFailure, applyExecutorJobSuccess } from '@convex/lib/executorJobs';
import { vExecutorJobResult, vExecutorJobStatus } from '@convex/lib/validators';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';
import type { Id } from '@convex/_generated/dataModel';

type ExecutorJobSnapshot = {
	jobId: Id<'executorJobs'>;
	status: Infer<typeof vExecutorJobStatus>;
	result?: Infer<typeof vExecutorJobResult>;
	error?: string;
};

export const complete = mutation({
	args: {
		jobId: v.id('executorJobs'),
		result: vExecutorJobResult,
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		try {
			const job = await ctx.db.get('executorJobs', args.jobId);
			if (!job || job.runId !== args.runId) throw new Error('Executor job not found.');
			const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
			return await applyExecutorJobSuccess(ctx, {
				job,
				run,
				result: args.result,
				claimId: args.claimId
			});
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const fail = mutation({
	args: {
		jobId: v.id('executorJobs'),
		error: v.string(),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		try {
			const job = await ctx.db.get('executorJobs', args.jobId);
			if (!job || job.runId !== args.runId) throw new Error('Executor job not found.');
			const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
			return await applyExecutorJobFailure(ctx, {
				job,
				run,
				error: args.error,
				claimId: args.claimId
			});
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const getJob = query({
	args: {
		jobId: v.id('executorJobs'),
		runId: v.id('runs'),
		executionSecret: v.string()
	},
	returns: v.union(
		v.null(),
		v.object({
			jobId: v.id('executorJobs'),
			status: vExecutorJobStatus,
			result: v.optional(vExecutorJobResult),
			error: v.optional(v.string())
		})
	),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const job = await ctx.db.get('executorJobs', args.jobId);
		if (!job || job.runId !== run._id) {
			return null;
		}
		const snapshot: ExecutorJobSnapshot = {
			jobId: job._id,
			status: job.status
		};
		if (job.result !== undefined) snapshot.result = job.result;
		if (job.error !== undefined) snapshot.error = job.error;
		return snapshot;
	}
});
