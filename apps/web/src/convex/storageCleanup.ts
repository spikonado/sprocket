import { v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { internalMutation } from '@convex/_generated/server';
import { registeredParseStorage } from '@convex/lib/hostedParse';

const UNREGISTERED_STORAGE_TTL_MS = 24 * 60 * 60 * 1_000;
const BATCH_SIZE = 100;

// Upload responses and action callbacks can be lost after bytes reach storage.
export const cleanupUnregistered = internalMutation({
	args: { cursor: v.optional(v.string()), cutoff: v.optional(v.number()) },
	returns: v.number(),
	handler: async (ctx, args) => {
		const cutoff = args.cutoff ?? Date.now() - UNREGISTERED_STORAGE_TTL_MS;
		const page = await ctx.db.system
			.query('_storage')
			.withIndex('by_creation_time', (q) => q.lt('_creationTime', cutoff))
			.paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
		let deleted = 0;
		for (const blob of page.page) {
			const attachment = await ctx.db
				.query('imageUploads')
				.withIndex('by_storageId', (q) => q.eq('storageId', blob._id))
				.first();
			if (attachment) continue;
			if (await registeredParseStorage(ctx, blob._id)) continue;
			await ctx.storage.delete(blob._id);
			deleted += 1;
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.storageCleanup.cleanupUnregistered, {
				cursor: page.continueCursor,
				cutoff
			});
		}
		return deleted;
	}
});
