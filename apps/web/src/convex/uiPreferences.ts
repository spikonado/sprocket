import { internalMutation, mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { vUiPreferencesDoc } from '@convex/lib/docs';

const vTheme = v.union(v.literal('light'), v.literal('dark'));

export const clearDarkTheme = internalMutation({
	args: {},
	returns: v.number(),
	handler: async (ctx) => {
		const rows = await ctx.db.query('uiPreferences').collect();
		let cleared = 0;
		for (const row of rows) {
			if (row.theme === 'dark') {
				await ctx.db.patch(row._id, { theme: undefined });
				cleared += 1;
			}
		}
		return cleared;
	}
});

export const getMine = query({
	args: {},
	returns: v.union(vUiPreferencesDoc, v.null()),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
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
	returns: v.union(vUiPreferencesDoc, v.null()),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
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
	returns: v.union(vUiPreferencesDoc, v.null()),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
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

export const setPaymentsEmail = mutation({
	args: { email: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const email = args.email.trim();
		if (!email) throw new Error('Email cannot be empty.');
		const existing = await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, { paymentsEmail: email });
		} else {
			await ctx.db.insert('uiPreferences', {
				userId,
				paymentsEmail: email
			});
		}
		return null;
	}
});
