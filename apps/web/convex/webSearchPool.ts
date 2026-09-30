import { Workpool, vOnCompleteArgs } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { components, internal } from '@convex/_generated/api';
import { internalMutation, type MutationCtx } from '@convex/_generated/server';
import type { Id } from '@convex/_generated/dataModel';
import { applyExecutorJobFailure, applyExecutorJobSuccess } from '@convex/lib/executorJobs';
import { vExecutorJobPayload } from '@convex/lib/validators';
import { claimedJobForActiveRun } from '@convex/lib/claimedWebJob';

export const webSearchWorkpool = new Workpool(components.webSearchWorkpool, {
	maxParallelism: 8,
	retryActionsByDefault: true,
	defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1_000, base: 2 }
});

const vWebSearchContext = v.object({
	jobId: v.id('executorJobs'),
	runId: v.id('runs'),
	claimId: v.string()
});

const vWebSearchJobSnapshot = v.union(
	v.null(),
	v.object({
		kind: v.literal('web_search'),
		payload: vExecutorJobPayload
	})
);

export function isCloudWebSearchKind(kind: string): kind is 'web_search' {
	return kind === 'web_search';
}

export async function enqueueWebSearchJob(
	ctx: MutationCtx,
	args: {
		jobId: Id<'executorJobs'>;
		runId: Id<'runs'>;
		claimId: string;
	}
): Promise<void> {
	const workId = await webSearchWorkpool.enqueueAction(
		ctx,
		internal.webTools.executeWebSearch,
		{ jobId: args.jobId, runId: args.runId, claimId: args.claimId },
		{
			onComplete: internal.webSearchPool.completeWebSearch,
			context: { jobId: args.jobId, runId: args.runId, claimId: args.claimId }
		}
	);
	await ctx.db.patch('executorJobs', args.jobId, { cloudWorkId: workId });
}

export const getWebSearchJob = internalMutation({
	args: vWebSearchContext.fields,
	returns: vWebSearchJobSnapshot,
	handler: async (ctx, args) => {
		const active = await claimedJobForActiveRun(ctx, args);
		if (!active || !isCloudWebSearchKind(active.job.kind)) {
			return null;
		}
		return { kind: active.job.kind, payload: active.job.payload };
	}
});

export const completeWebSearch = internalMutation({
	args: vOnCompleteArgs(vWebSearchContext),
	returns: v.null(),
	handler: async (ctx, args) => {
		const active = await claimedJobForActiveRun(ctx, args.context);
		if (!active) {
			return null;
		}
		if (args.result.kind === 'canceled') {
			return null;
		}
		const { job, run } = active;
		if (args.result.kind === 'success') {
			await applyExecutorJobSuccess(ctx, {
				job,
				run,
				result: args.result.returnValue,
				claimId: args.context.claimId
			});
			return null;
		}
		await applyExecutorJobFailure(ctx, {
			job,
			run,
			error: args.result.error,
			claimId: args.context.claimId
		});
		return null;
	}
});
