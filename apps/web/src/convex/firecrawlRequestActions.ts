'use node';

import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { internalAction } from '@convex/_generated/server';
import { interact, screenshot } from '@convex/firecrawlBrowser';
import { executeQueuedScrape } from '@convex/webTools';
import { REQUEST_TTL_MS } from '@convex/firecrawlRequests';

export const execute = internalAction({
	args: { id: v.id('firecrawlRequests') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const claimed = await ctx.runMutation(internal.firecrawlRequests.claim, { id });
		if (!claimed) return null;
		const { request, userId, threadId } = claimed;
		const args = { runId: request.runId, claimId: request.claimId, userId, threadId };
		const result =
			request.kind === 'browser_interact'
				? await interact(ctx, {
						...args,
						command: request.command ?? '',
						enforce_saving: request.enforce_saving
					})
				: request.kind === 'browser_screenshot'
					? await screenshot(ctx, args)
					: await executeQueuedScrape(ctx, request);
		const storageId = await ctx.storage.store(
			new Blob([JSON.stringify(result)], { type: 'application/json' })
		);
		try {
			await ctx.scheduler.runAfter(REQUEST_TTL_MS, internal.firecrawlRequests.removeResult, {
				storageId
			});
		} catch (error) {
			await ctx.storage.delete(storageId);
			throw error;
		}
		await ctx.runMutation(internal.firecrawlRequests.publish, { id, storageId });
		return null;
	}
});
