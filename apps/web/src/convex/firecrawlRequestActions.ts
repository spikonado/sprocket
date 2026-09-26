'use node';

import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { internalAction } from '@convex/_generated/server';
import { executeQueuedScrape } from '@convex/webTools';
import { REQUEST_TTL_MS } from '@convex/firecrawlRequests';

export const execute = internalAction({
	args: { id: v.id('firecrawlRequests') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const claimed = await ctx.runMutation(internal.firecrawlRequests.claim, { id });
		if (!claimed) return null;
		const { request } = claimed;
		const result = await executeQueuedScrape(ctx, request);
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
