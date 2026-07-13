import { mutation } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedExecutorJob } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { executorFailureRunPatch } from '@convex/lib/runs';
import { isRunFinalStatus, vExecutorJobResult } from '@convex/lib/validators';

export const complete = mutation({
	args: {
		guestId: v.optional(v.string()),
		jobId: v.id('executorJobs'),
		result: vExecutorJobResult
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const job = await getOwnedExecutorJob(ctx.db, userId, args.jobId);
		const run = await ctx.db.get(job.runId);
		if (job.status === 'cancelled' || job.status === 'failed') {
			return false;
		}
		if (job.status === 'completed') {
			return true;
		}
		if (!run || isRunFinalStatus(run.status)) {
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
		guestId: v.optional(v.string()),
		jobId: v.id('executorJobs'),
		error: v.string()
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const job = await getOwnedExecutorJob(ctx.db, userId, args.jobId);
		if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
			return false;
		}

		const completedAt = Date.now();
		await ctx.db.patch(args.jobId, {
			status: 'failed',
			error: args.error,
			completedAt
		});
		const run = await ctx.db.get(job.runId);
		if (run) {
			const runPatch = executorFailureRunPatch({
				runStatus: run.status,
				activeJobId: run.activeJobId,
				failedJobId: args.jobId
			});
			if (runPatch) {
				await ctx.db.patch(job.runId, runPatch);
			}
		}
		return true;
	}
});
