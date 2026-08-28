import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import schema from '@convex/schema';

const vTheme = v.union(v.literal('light'), v.literal('dark'));

export const getMine = query({
	args: {},
	returns: v.union(schema.doc('uiPreferences'), v.null()),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		return await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();
	}
});

/** Retired session-restore write. Kept so older UIs get an update message. */
export const setLastThread = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const setTheme = mutation({
	args: {
		theme: vTheme
	},
	returns: v.union(schema.doc('uiPreferences'), v.null()),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const existing = await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();

		if (existing) {
			await ctx.db.patch('uiPreferences', existing._id, {
				theme: args.theme
			});
			return await ctx.db.get('uiPreferences', existing._id);
		}

		const id = await ctx.db.insert('uiPreferences', {
			userId,
			theme: args.theme
		});
		return await ctx.db.get('uiPreferences', id);
	}
});

/** Retired payments-email write. Kept so older settings screens get an update message. */
export const setPaymentsEmail = mutation({
	args: { email: v.string() },
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});
