'use node';

import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { internalAction } from '@convex/_generated/server';
import { executeQueuedWebRequest } from '@convex/webTools';
import { REQUEST_TTL_MS } from '@convex/webRequests';

export const execute = internalAction({
	args: { id: v.id('webRequests') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const claimed = await ctx.runMutation(internal.webRequests.claim, { id });

		if (!claimed) return null;
		const result = await executeQueuedWebRequest(ctx, claimed.request);

		const storageId = await ctx.storage.store(
			new Blob([JSON.stringify(result)], { type: 'application/json' })
		);

		try {
			await ctx.scheduler.runAfter(REQUEST_TTL_MS, internal.webRequests.removeResult, {
				storageId
			});
		} catch (error) {
			await ctx.storage.delete(storageId);
			throw error;
		}

		await ctx.runMutation(internal.webRequests.publish, { id, storageId });

		return null;
	}
});
