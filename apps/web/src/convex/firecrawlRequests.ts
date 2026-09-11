import { vOnCompleteArgs, type WorkId } from '@convex-dev/workpool';
import { ConvexError, v } from 'convex/values';
import { getRunWithExecution } from '@convex/lib/runExecution';
import { internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	env,
	internalMutation,
	mutation,
	query,
	type MutationCtx
} from '@convex/_generated/server';
import { getExecutionRun } from '@convex/lib/auth';
import { RUN_NO_LONGER_ACTIVE, toAgentToolConvexError } from '@convex/lib/agentErrors';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { firecrawlBrowserPool, firecrawlScrapePool } from '@convex/lib/firecrawlPools';
import { claimedJobForActiveRun } from '@convex/lib/claimedWebJob';
import schema from '@convex/schema';
import { isRunFinalStatus } from '@convex/lib/validators';

export const REQUEST_TTL_MS = 8 * 60_000;
export const vRequestArgs = schema
	.doc('firecrawlRequests')
	.pick('runId', 'claimId', 'jobId', 'kind', 'command', 'enforce_saving');

export const scrapeJob = internalMutation({
	args: { runId: v.id('runs'), claimId: v.string(), jobId: v.id('executorJobs') },
	handler: async (ctx, args) => {
		const active = await claimedJobForActiveRun(ctx, args);
		if (!active || active.job.status !== 'claimed' || active.job.cloudWorkId !== undefined)
			return null;
		if (active.job.kind !== 'scrape_url' && active.job.kind !== 'screenshot_url') return null;
		return { kind: active.job.kind, payload: active.job.payload };
	}
});

function poolFor(request: Pick<Doc<'firecrawlRequests'>, 'kind'>) {
	return request.kind.startsWith('browser_') ? firecrawlBrowserPool : firecrawlScrapePool;
}

async function activeRun(
	ctx: MutationCtx,
	request: Pick<Doc<'firecrawlRequests'>, 'runId' | 'claimId' | 'jobId' | 'kind'>
) {
	const run = await getRunWithExecution(ctx.db, request.runId);
	if (
		!run ||
		run.cancellationRequestedAt !== undefined ||
		run.claimId !== request.claimId ||
		!isRunClaimLeaseActive(run, Date.now())
	) {
		throw new ConvexError(RUN_NO_LONGER_ACTIVE);
	}
	if (request.kind === 'scrape' || request.kind === 'screenshot') {
		if (!request.jobId) throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		const active = await claimedJobForActiveRun(ctx, { ...request, jobId: request.jobId });
		if (
			!active ||
			active.job.kind !== `${request.kind}_url` ||
			active.job.status !== 'claimed' ||
			active.job.cloudWorkId !== undefined
		) {
			throw new ConvexError(RUN_NO_LONGER_ACTIVE);
		}
	}
	return run;
}

export const enqueue = internalMutation({
	args: { ...vRequestArgs.fields, executionSecret: v.string() },
	returns: v.id('firecrawlRequests'),
	handler: async (ctx, { executionSecret, ...args }) => {
		await getExecutionRun(ctx, args.runId, executionSecret);
		await activeRun(ctx, args);
		if (args.kind.startsWith('browser_') && !env.FIRECRAWL_BROWSER_API_KEY?.trim()) {
			throw new ConvexError('FIRECRAWL_BROWSER_API_KEY is not configured.');
		}
		const id = await ctx.db.insert('firecrawlRequests', {
			...args,
			status: 'queued',
			expiresAt: Date.now() + REQUEST_TTL_MS
		});
		const workId = await poolFor(args).enqueueAction(
			ctx,
			internal.firecrawlRequestActions.execute,
			{ id },
			{
				retry: false,
				onComplete: internal.firecrawlRequests.complete,
				context: { id }
			}
		);
		await ctx.db.patch('firecrawlRequests', id, { workId });
		await ctx.scheduler.runAfter(REQUEST_TTL_MS, internal.firecrawlRequests.cleanup, { id });
		return id;
	}
});

export const start = mutation({
	args: { ...vRequestArgs.fields, executionSecret: v.string() },
	returns: v.id('firecrawlRequests'),
	handler: async (ctx, args): Promise<Id<'firecrawlRequests'>> =>
		await ctx.runMutation(internal.firecrawlRequests.enqueue, args)
});

export const getResult = query({
	args: { id: v.id('firecrawlRequests'), runId: v.id('runs'), executionSecret: v.string() },
	returns: v.union(
		v.object({ status: v.literal('pending') }),
		v.object({ status: v.literal('completed'), url: v.string() }),
		v.object({ status: v.literal('failed'), error: v.string() })
	),
	handler: async (ctx, args) => {
		const run = await getExecutionRun(ctx, args.runId, args.executionSecret);
		const request = await ctx.db.get('firecrawlRequests', args.id);
		if (
			!request ||
			request.runId !== run._id ||
			request.claimId !== run.claimId ||
			run.cancellationRequestedAt !== undefined ||
			isRunFinalStatus(run.status)
		) {
			return {
				status: 'failed' as const,
				error:
					'Firecrawl request ended. If a browser command was submitted, check its outcome before repeating purchases, messages, or other actions.'
			};
		}
		if (request.status === 'failed')
			return { status: 'failed' as const, error: request.error ?? 'Firecrawl request failed.' };
		if (request.status === 'completed' && request.resultStorageId) {
			const url = await ctx.storage.getUrl(request.resultStorageId);
			if (url) return { status: 'completed' as const, url };
			return { status: 'failed' as const, error: 'Firecrawl result is no longer available.' };
		}
		return { status: 'pending' as const };
	}
});

export const dispose = mutation({
	args: { id: v.id('firecrawlRequests'), runId: v.id('runs'), executionSecret: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await getExecutionRun(ctx, args.runId, args.executionSecret);
		const request = await ctx.db.get('firecrawlRequests', args.id);
		if (request?.runId === args.runId) await remove(ctx, request);
		return null;
	}
});

export const claim = internalMutation({
	args: { id: v.id('firecrawlRequests') },
	returns: v.union(
		v.object({
			request: schema.doc('firecrawlRequests'),
			userId: v.string(),
			threadId: v.id('threadRecords')
		}),
		v.null()
	),
	handler: async (ctx, { id }) => {
		const request = await ctx.db.get('firecrawlRequests', id);
		if (!request || request.status !== 'queued' || request.expiresAt <= Date.now()) return null;
		const run = await activeRun(ctx, request);
		await ctx.db.patch('firecrawlRequests', id, { status: 'running' });
		return { request, userId: run.userId, threadId: run.threadId };
	}
});

export const publish = internalMutation({
	args: { id: v.id('firecrawlRequests'), storageId: v.id('_storage') },
	returns: v.null(),
	handler: async (ctx, { id, storageId }) => {
		const request = await ctx.db.get('firecrawlRequests', id);
		if (!request || request.status !== 'running' || request.expiresAt <= Date.now()) {
			await ctx.storage.delete(storageId);
			return null;
		}
		try {
			await activeRun(ctx, request);
		} catch {
			await ctx.storage.delete(storageId);
			await ctx.db.patch('firecrawlRequests', id, {
				status: 'failed',
				error: RUN_NO_LONGER_ACTIVE
			});
			return null;
		}
		await ctx.db.patch('firecrawlRequests', id, {
			status: 'completed',
			resultStorageId: storageId
		});
		return null;
	}
});

export const complete = internalMutation({
	args: vOnCompleteArgs(v.object({ id: v.id('firecrawlRequests') })),
	returns: v.null(),
	handler: async (ctx, { context, result }) => {
		const request = await ctx.db.get('firecrawlRequests', context.id);
		if (!request || request.status === 'completed' || request.status === 'failed') return null;
		const error =
			result.kind === 'failed'
				? toAgentToolConvexError(new Error(result.error)).message
				: 'Firecrawl request did not return a result.';
		await ctx.db.patch('firecrawlRequests', request._id, {
			status: 'failed',
			error: error.slice(0, 16_000)
		});
		return null;
	}
});

export const poll = internalMutation({
	args: { id: v.id('firecrawlRequests') },
	returns: v.object({
		status: v.string(),
		storageId: v.optional(v.id('_storage')),
		error: v.optional(v.string())
	}),
	handler: async (ctx, { id }) => {
		const request = await ctx.db.get('firecrawlRequests', id);
		if (!request || request.expiresAt <= Date.now()) {
			return {
				status: 'failed',
				error:
					'Firecrawl request timed out. If a browser command was submitted, check its outcome before repeating purchases, messages, or other actions.'
			};
		}
		await activeRun(ctx, request);
		return { status: request.status, storageId: request.resultStorageId, error: request.error };
	}
});

async function remove(ctx: MutationCtx, request: Doc<'firecrawlRequests'>) {
	if (request.workId && (request.status === 'queued' || request.status === 'running')) {
		// SAFETY: Stored directly from this pool's enqueueAction result.
		await poolFor(request).cancel(ctx, request.workId as WorkId);
	}
	if (request.resultStorageId) await ctx.storage.delete(request.resultStorageId);
	await ctx.db.delete('firecrawlRequests', request._id);
}

export const cleanup = internalMutation({
	args: { id: v.id('firecrawlRequests') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const request = await ctx.db.get('firecrawlRequests', id);
		if (request) await remove(ctx, request);
		return null;
	}
});

export const removeResult = internalMutation({
	args: { storageId: v.id('_storage') },
	returns: v.null(),
	handler: async (ctx, { storageId }) => {
		await ctx.storage.delete(storageId);
		return null;
	}
});

export async function cancelFirecrawlRequests(ctx: MutationCtx, runId: Id<'runs'>) {
	const requests = await ctx.db
		.query('firecrawlRequests')
		.withIndex('by_runId', (q) => q.eq('runId', runId))
		.take(32);
	for (const request of requests) await remove(ctx, request);
	if (requests.length === 32)
		await ctx.scheduler.runAfter(0, internal.firecrawlRequests.cancelRun, { runId });
}

export const cancelRun = internalMutation({
	args: { runId: v.id('runs') },
	returns: v.null(),
	handler: async (ctx, { runId }) => {
		await cancelFirecrawlRequests(ctx, runId);
		return null;
	}
});
