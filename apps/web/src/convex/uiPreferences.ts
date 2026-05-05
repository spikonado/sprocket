import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';

export const getMine = query({
	args: {
		guestId: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		return await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();
	}
});

export const setLastThread = mutation({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.string()
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const existing = await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				lastThreadId: args.threadId
			});
			return await ctx.db.get(existing._id);
		}

		const id = await ctx.db.insert('uiPreferences', {
			userId,
			lastThreadId: args.threadId
		});
		return await ctx.db.get(id);
	}
});
