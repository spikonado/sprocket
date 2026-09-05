import { ConvexError, v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { mutation, query } from '@convex/_generated/server';
import { getUserId } from '@convex/lib/auth';
import { getOwnedThreadRecord } from '@convex/lib/access';

export const getMine = query({
	args: {},
	returns: v.object({ savingEnabled: v.boolean() }),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const profile = await ctx.db
			.query('browserProfiles')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique();
		return { savingEnabled: profile?.savingEnabled ?? true };
	}
});

export const setSaving = mutation({
	args: { enabled: v.boolean() },
	returns: v.null(),
	handler: async (ctx, { enabled }) => {
		const userId = await getUserId(ctx);
		const profile = await ctx.db
			.query('browserProfiles')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique();
		if (profile) await ctx.db.patch('browserProfiles', profile._id, { savingEnabled: enabled });
		else
			await ctx.db.insert('browserProfiles', {
				userId,
				name: `sprocket-${crypto.randomUUID()}`,
				savingEnabled: enabled
			});
		return null;
	}
});

export const reset = mutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const profile = await ctx.db
			.query('browserProfiles')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique();
		if (profile)
			await ctx.db.patch('browserProfiles', profile._id, {
				name: `sprocket-${crypto.randomUUID()}`
			});
		const sessions = await ctx.db
			.query('browserSessions')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.take(100);
		for (const session of sessions) {
			await ctx.db.patch('browserSessions', session._id, { closing: true });
			await ctx.scheduler.runAfter(0, internal.firecrawlBrowser.close, { id: session._id });
		}
		return null;
	}
});

export const setHumanControl = mutation({
	args: { threadId: v.id('threadRecords'), enabled: v.boolean() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const session = await ctx.db
			.query('browserSessions')
			.withIndex('by_threadId', (q) => q.eq('threadId', args.threadId))
			.unique();
		if (!session || session.closing || !session.sessionId || session.expiresAt <= Date.now())
			throw new ConvexError('This browser session has ended.');
		if (session.operationId && session.operationExpiresAt > Date.now())
			throw new ConvexError('Wait for the current browser action to finish before taking control.');
		await ctx.db.patch('browserSessions', session._id, { humanControl: args.enabled });
		return null;
	}
});
