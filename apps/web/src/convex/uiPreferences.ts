import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';

const vTheme = v.union(v.literal('light'), v.literal('dark'));

export const getMine = query({
	args: {},
	handler: async (ctx) => {
		const userId: string = await getUserId(ctx);
		return await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();
	}
});

export const setLastThread = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx);
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

export const setTheme = mutation({
	args: {
		theme: vTheme
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx);
		const existing = await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, {
				theme: args.theme
			});
			return await ctx.db.get(existing._id);
		}

		const id = await ctx.db.insert('uiPreferences', {
			userId,
			theme: args.theme
		});
		return await ctx.db.get(id);
	}
});
