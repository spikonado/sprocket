import { Workpool, vOnCompleteArgs, type WorkId } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { components, internal } from '@convex/_generated/api';
import { internalMutation, internalQuery, type MutationCtx } from '@convex/_generated/server';
import type { Id } from '@convex/_generated/dataModel';
import { applyExecutorJobFailure, applyExecutorJobSuccess } from '@convex/lib/executorJobs';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';
import { isRunFinalStatus, vExecutorJobPayload } from '@convex/lib/validators';
import { ownsActiveRunClaim } from '@convex/lib/runLease';

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

export function isCloudWebToolKind(kind: string): kind is 'web_search' | 'scrape_url' {
	return kind === 'web_search' || kind === 'scrape_url';
}

export async function enqueueWebToolJob(
	ctx: MutationCtx,
	args: {
		jobId: Id<'executorJobs'>;
		runId: Id<'runs'>;
		claimId: string;
		kind: 'web_search' | 'scrape_url';
	}
): Promise<void> {
	const action =
		args.kind === 'web_search'
			? internal.webTools.executeWebSearch
			: internal.webTools.executeScrapeUrl;
	const workId = await webToolWorkpool.enqueueAction(
		ctx,
		action,
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
				await webToolWorkpool.cancel(ctx, job.cloudWorkId as WorkId);
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

export const getWebToolJob = internalQuery({
	args: {
		jobId: v.id('executorJobs'),
		runId: v.id('runs'),
		claimId: v.string()
	},
	returns: v.union(
		v.null(),
		v.object({
			kind: v.union(v.literal('web_search'), v.literal('scrape_url')),
			payload: vExecutorJobPayload
		})
	),
	handler: async (ctx, args) => {
		const job = await ctx.db.get('executorJobs', args.jobId);
		if (!job || job.runId !== args.runId || !isCloudWebToolKind(job.kind)) {
			return null;
		}
		if (isSettledExecutorJobStatus(job.status)) {
			return null;
		}
		const run = await ctx.db.get('runs', args.runId);
		if (!run || !ownsActiveRunClaim(run, args.claimId, Date.now())) {
			return null;
		}
		return { kind: job.kind, payload: job.payload };
	}
});

export const completeWebTool = internalMutation({
	args: vOnCompleteArgs(vWebToolContext),
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db.get('executorJobs', args.context.jobId);
		if (!job || job.runId !== args.context.runId) {
			return null;
		}
		if (isSettledExecutorJobStatus(job.status)) {
			return null;
		}
		const run = await ctx.db.get('runs', args.context.runId);
		if (!run || isRunFinalStatus(run.status)) {
			return null;
		}
		if (!ownsActiveRunClaim(run, args.context.claimId, Date.now())) {
			return null;
		}
		if (args.result.kind === 'canceled') {
			return null;
		}
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
