import { Workpool, vOnCompleteArgs, type WorkId } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { components, internal } from '@convex/_generated/api';
import { internalMutation, type MutationCtx } from '@convex/_generated/server';
import type { Id } from '@convex/_generated/dataModel';
import { applyExecutorJobFailure, applyExecutorJobSuccess } from '@convex/lib/executorJobs';
import { registeredParseStorage } from '@convex/lib/hostedParse';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';
import { vExecutorJobPayload } from '@convex/lib/validators';
import { claimedJobForActiveRun } from '@convex/lib/claimedWebJob';
import { firecrawlScrapePool } from '@convex/lib/firecrawlPools';
import { cancelFirecrawlRequests } from '@convex/firecrawlRequests';

export const webToolWorkpool = new Workpool(components.webToolWorkpool, {
	maxParallelism: 4,
	retryActionsByDefault: true,
	defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1_000, base: 2 }
});

const vWebToolContext = v.object({
	jobId: v.id('executorJobs'),
	runId: v.id('runs'),
	claimId: v.string()
});

const vWebToolJobSnapshot = v.union(
	v.null(),
	v.object({
		kind: v.literal('web_search'),
		payload: vExecutorJobPayload
	})
);

export function isCloudWebToolKind(kind: string): kind is 'web_search' {
	return kind === 'web_search';
}

export async function enqueueWebToolJob(
	ctx: MutationCtx,
	args: {
		jobId: Id<'executorJobs'>;
		runId: Id<'runs'>;
		claimId: string;
		kind: 'web_search';
	}
): Promise<void> {
	const workId = await webToolWorkpool.enqueueAction(
		ctx,
		internal.webTools.executeWebSearch,
		{ jobId: args.jobId, runId: args.runId, claimId: args.claimId },
		{
			onComplete: internal.webToolPool.completeWebTool,
			context: { jobId: args.jobId, runId: args.runId, claimId: args.claimId }
		}
	);
	await ctx.db.patch('executorJobs', args.jobId, { cloudWorkId: workId });
}

const CANCEL_PAGE_SIZE = 32;

export async function cancelWebToolWork(ctx: MutationCtx, runId: Id<'runs'>): Promise<void> {
	await cancelFirecrawlRequests(ctx, runId);
	let afterSequence = -1;
	for (;;) {
		const jobs = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_sequence', (query) =>
				query.eq('runId', runId).gt('sequence', afterSequence)
			)
			.take(CANCEL_PAGE_SIZE);
		if (jobs.length === 0) {
			return;
		}
		for (const job of jobs) {
			if (!job.cloudWorkId || isSettledExecutorJobStatus(job.status)) {
				continue;
			}
			try {
				// SAFETY: cloudWorkId is the WorkId returned by enqueueAction.
				await (job.kind === 'web_search' ? webToolWorkpool : firecrawlScrapePool).cancel(
					ctx,
					job.cloudWorkId as WorkId
				);
			} catch {
				// Best-effort; callbacks are fenced on job/claim state.
			}
		}
		const last = jobs.at(-1);
		if (!last || jobs.length < CANCEL_PAGE_SIZE) {
			return;
		}
		afterSequence = last.sequence;
	}
}

export const getWebToolJob = internalMutation({
	args: vWebToolContext.fields,
	returns: vWebToolJobSnapshot,
	handler: async (ctx, args) => {
		const active = await claimedJobForActiveRun(ctx, args);
		if (!active || !isCloudWebToolKind(active.job.kind)) {
			return null;
		}
		return { kind: active.job.kind, payload: active.job.payload };
	}
});

export const completeWebTool = internalMutation({
	args: vOnCompleteArgs(vWebToolContext),
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

async function deleteUnregisteredStorage(
	ctx: MutationCtx,
	storageId: Id<'_storage'>
): Promise<void> {
	const attached = await ctx.db
		.query('imageUploads')
		.withIndex('by_storageId', (query) => query.eq('storageId', storageId))
		.unique();
	if (attached) return;
	if (await registeredParseStorage(ctx, storageId)) return;
	if (await ctx.db.system.get('_storage', storageId)) {
		await ctx.storage.delete(storageId);
	}
}

export const deleteTemporaryStorage = internalMutation({
	args: { storageId: v.id('_storage') },
	returns: v.null(),
	handler: async (ctx, args) => {
		await deleteUnregisteredStorage(ctx, args.storageId);
		return null;
	}
});
