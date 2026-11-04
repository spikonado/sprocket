import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v, type Infer, type ObjectType } from 'convex/values';
import { getExecutionRun, getExecutionRunRecord } from '@convex/lib/auth';
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

const completeArgs = {
	jobId: v.id('executorJobs'),
	result: vExecutorJobResult,
	runId: v.id('runs'),
	claimId: v.string(),
	executionSecret: v.string()
};

export async function completeHandler(ctx: MutationCtx, args: ObjectType<typeof completeArgs>) {
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

export const complete = mutation({
	args: completeArgs,
	returns: v.boolean(),
	handler: completeHandler
});

const failArgs = {
	jobId: v.id('executorJobs'),
	error: v.string(),
	runId: v.id('runs'),
	claimId: v.string(),
	executionSecret: v.string()
};

export async function failHandler(ctx: MutationCtx, args: ObjectType<typeof failArgs>) {
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

export const fail = mutation({
	args: failArgs,
	returns: v.boolean(),
	handler: failHandler
});

const getJobArgs = {
	jobId: v.id('executorJobs'),
	runId: v.id('runs'),
	executionSecret: v.string()
};

export async function getJobHandler(ctx: QueryCtx, args: ObjectType<typeof getJobArgs>) {
	const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);
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

export const getJob = query({
	args: getJobArgs,
	returns: v.union(
		v.null(),
		v.object({
			jobId: v.id('executorJobs'),
			status: vExecutorJobStatus,
			result: v.optional(vExecutorJobResult),
			error: v.optional(v.string())
		})
	),
	handler: getJobHandler
});
