import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from '@convex/_generated/server';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';

const browserSessionDoc = v.object({
	_id: v.id('browserSessions'),
	_creationTime: v.number(),
	threadId: v.id('threadRecords'),
	runId: v.id('runs'),
	userId: v.string(),
	browserbaseSessionId: v.string(),
	liveViewUrl: v.optional(v.string()),
	startedAt: v.number()
});

export const getForThread = internalQuery({
	args: { threadId: v.id('threadRecords'), userId: v.string() },
	returns: v.union(browserSessionDoc, v.null()),
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query('browserSessions')
			.withIndex('by_thread', (query) => query.eq('threadId', args.threadId))
			.first();
		return session?.userId === args.userId ? session : null;
	}
});

/** The browser live-view state shown in the thread's side panel. */
export const liveViewForThread = query({
	args: { threadId: v.id('threadRecords') },
	returns: v.union(
		v.object({
			liveViewUrl: v.union(v.string(), v.null()),
			startedAt: v.number()
		}),
		v.null()
	),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const session = await ctx.db
			.query('browserSessions')
			.withIndex('by_thread', (query) => query.eq('threadId', args.threadId))
			.first();
		if (!session) return null;
		return { liveViewUrl: session.liveViewUrl ?? null, startedAt: session.startedAt };
	}
});

/** Record the live Browserbase session for a thread, replacing any prior one.
 * Transactional, so concurrent runs in a thread can't leave duplicate rows
 * pointing at different sessions. runId tracks which run (re)created it. */
export const upsertForThread = internalMutation({
	args: {
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		userId: v.string(),
		browserbaseSessionId: v.string(),
		liveViewUrl: v.optional(v.string())
	},
	returns: v.id('browserSessions'),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('browserSessions')
			.withIndex('by_thread', (query) => query.eq('threadId', args.threadId))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, {
				runId: args.runId,
				userId: args.userId,
				browserbaseSessionId: args.browserbaseSessionId,
				...(args.liveViewUrl ? { liveViewUrl: args.liveViewUrl } : {}),
				startedAt: Date.now()
			});
			return existing._id;
		}
		return await ctx.db.insert('browserSessions', {
			...args,
			startedAt: Date.now()
		});
	}
});

/** Backfill the live view URL for the thread's current session without
 * touching startedAt — a new session signals fresh agent activity (the side
 * panel auto-opens); a backfilled URL for the same session must not. */
export const setLiveViewUrl = internalMutation({
	args: { threadId: v.id('threadRecords'), liveViewUrl: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('browserSessions')
			.withIndex('by_thread', (query) => query.eq('threadId', args.threadId))
			.first();
		if (existing && !existing.liveViewUrl) {
			await ctx.db.patch(existing._id, { liveViewUrl: args.liveViewUrl });
		}
		return null;
	}
});
