import { ConvexError, v } from 'convex/values';
import { mutation, query } from '@convex/_generated/server';
import { RUN_NO_LONGER_ACTIVE, TOOL_NO_LONGER_SUPPORTED } from '@convex/lib/agentErrors';
import {
	REQUEST_ENDED,
	disposeRequest,
	enqueueRequest,
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
	handler: async (ctx, { kind, jobId, ...args }) => {
		if (kind === 'screenshot') throw new ConvexError(TOOL_NO_LONGER_SUPPORTED);

		if (!jobId) throw new ConvexError(RUN_NO_LONGER_ACTIVE);

		return await enqueueRequest(ctx, { ...args, jobId, kind });
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
