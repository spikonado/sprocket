import { ConvexError, v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { internalMutation, mutation, query } from '@convex/_generated/server';
import { RUN_NO_LONGER_ACTIVE, TOOL_NO_LONGER_SUPPORTED } from '@convex/lib/agentErrors';
import {
	REQUEST_ENDED,
	disposeRequest,
	readRequestResult,
	vRequestResult
} from '@convex/webRequests';

// Released agents still call these names; see "Firecrawl request endpoints" in BACKWARDS_COMPATIBILITY.md.

export const start = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		jobId: v.optional(v.id('executorJobs')),
		kind: v.union(v.literal('scrape'), v.literal('screenshot')),
		rawDocument: v.optional(v.boolean()),
		executionSecret: v.string()
	},
	returns: v.string(),
	handler: async (ctx, { kind, jobId, ...args }): Promise<Id<'webRequests'>> => {
		if (kind === 'screenshot') throw new ConvexError(TOOL_NO_LONGER_SUPPORTED);

		if (!jobId) throw new ConvexError(RUN_NO_LONGER_ACTIVE);

		return await ctx.runMutation(internal.webRequests.enqueue, { ...args, jobId, kind });
	}
});

const vLegacyRequestArgs = { id: v.string(), runId: v.id('runs'), executionSecret: v.string() };

export const getResult = query({
	args: vLegacyRequestArgs,
	returns: vRequestResult,
	handler: async (ctx, { id, ...args }) => {
		const requestId = ctx.db.normalizeId('webRequests', id);

		if (!requestId) return { status: 'failed' as const, error: REQUEST_ENDED };

		return await readRequestResult(ctx, { ...args, id: requestId });
	}
});

export const dispose = mutation({
	args: vLegacyRequestArgs,
	returns: v.null(),
	handler: async (ctx, { id, ...args }) => {
		const requestId = ctx.db.normalizeId('webRequests', id);

		if (requestId) await disposeRequest(ctx, { ...args, id: requestId });

		return null;
	}
});

/** Runs cleanup jobs scheduled before the webRequests rename. */
export const cleanup = internalMutation({
	args: { id: v.id('firecrawlRequests') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const request = await ctx.db.get('firecrawlRequests', id);

		if (!request) return null;

		if (request.resultStorageId) await ctx.storage.delete(request.resultStorageId);
		await ctx.db.delete('firecrawlRequests', id);

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
