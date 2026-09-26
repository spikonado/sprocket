import { v } from 'convex/values';
import { mutation, query } from '@convex/_generated/server';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';

/** The browser live-view state shown in the thread's side panel. */
export const liveViewForThread = query({
	args: { threadId: v.id('threadRecords') },
	returns: v.union(
		v.object({
			id: v.id('browserSessions'),
			providerSessionId: v.union(v.string(), v.null()),
			url: v.union(v.string(), v.null()),
			interactiveUrl: v.union(v.string(), v.null()),
			saving: v.boolean(),
			humanControl: v.boolean(),
			ended: v.boolean(),
			threadId: v.id('threadRecords'),
			expiresAt: v.number(),
			/** Run that most recently drove the browser; the client compares it to the active run. */
			lastUsedRunId: v.union(v.id('runs'), v.null()),
			startedAt: v.number()
		}),
		v.null()
	),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const session = await ctx.db
			.query('browserSessions')
			.withIndex('by_threadId', (q) => q.eq('threadId', args.threadId))
			.unique();
		if (!session) return null;
		return {
			id: session._id,
			providerSessionId: session.sessionId ?? null,
			url: session.closing ? null : (session.liveViewUrl ?? null),
			interactiveUrl: session.closing ? null : (session.interactiveLiveViewUrl ?? null),
			saving: session.saveChanges,
			humanControl: session.humanControl ?? false,
			ended: session.closing,
			threadId: session.threadId,
			expiresAt: session.expiresAt,
			lastUsedRunId: session.closing ? null : session.lastUsedRunId,
			startedAt: session.startedAt
		};
	}
});

export const stop = mutation({
	args: { id: v.id('browserSessions'), providerSessionId: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, { id, providerSessionId }) => {
		const userId = await getUserId(ctx);
		const session = await ctx.db.get('browserSessions', id);
		if (!session) return null;
		await getOwnedThreadRecord(ctx.db, userId, session.threadId);
		if (session.closing || (session.sessionId ?? null) !== providerSessionId) return null;
		await ctx.db.patch('browserSessions', id, {
			closing: true,
			operationId: undefined,
			operationExpiresAt: 0
		});
		return null;
	}
});
