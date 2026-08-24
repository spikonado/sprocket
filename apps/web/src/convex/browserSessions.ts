import { v } from 'convex/values';
import type { Id } from '@convex/_generated/dataModel';
import { internalMutation, internalQuery, query } from '@convex/_generated/server';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';

type BrowserSessionUpsertPatch = {
	runId: Id<'runs'>;
	lastUsedRunId: Id<'runs'>;
	userId: string;
	browserbaseSessionId: string;
	startedAt: number;
	liveViewUrl?: string;
};

const browserSessionDoc = v.object({
	_id: v.id('browserSessions'),
	_creationTime: v.number(),
	threadId: v.id('threadRecords'),
	runId: v.id('runs'),
	lastUsedRunId: v.id('runs'),
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
			url: v.union(v.string(), v.null()),
			/** Run that most recently drove the browser; the client compares it
			 * against the active run for liveness and auto-open. */
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
			.withIndex('by_thread', (query) => query.eq('threadId', args.threadId))
			.first();
		if (!session) return null;
		return {
			url: session.liveViewUrl ?? null,
			lastUsedRunId: session.lastUsedRunId,
			startedAt: session.startedAt
		};
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
			// A rotated session must not keep the dead session's URL when its own
			// live view URL is not known yet: patching undefined clears the field.
			const rotated = existing.browserbaseSessionId !== args.browserbaseSessionId;
			const patch: BrowserSessionUpsertPatch = {
				runId: args.runId,
				lastUsedRunId: args.runId,
				userId: args.userId,
				browserbaseSessionId: args.browserbaseSessionId,
				startedAt: Date.now()
			};
			if (args.liveViewUrl || rotated) patch.liveViewUrl = args.liveViewUrl;
			await ctx.db.patch(existing._id, patch);
			return existing._id;
		}
		return await ctx.db.insert('browserSessions', {
			...args,
			lastUsedRunId: args.runId,
			startedAt: Date.now()
		});
	}
});

/** Record that `runId` used the thread's browser session. Unlike the session
 * (re)create signal, this fires on reuse too. It's how the client learns the
 * agent started browsing in a run that kept the previous session. */
export const touchForThread = internalMutation({
	args: { threadId: v.id('threadRecords'), runId: v.id('runs') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('browserSessions')
			.withIndex('by_thread', (query) => query.eq('threadId', args.threadId))
			.first();
		if (existing && existing.lastUsedRunId !== args.runId) {
			await ctx.db.patch(existing._id, { lastUsedRunId: args.runId });
		}
		return null;
	}
});

/** Backfill the live view URL for the thread's current session without
 * touching startedAt. A new session signals fresh agent activity (the side
 * panel auto-opens); a backfilled URL for the same session must not. */
export const setLiveViewUrl = internalMutation({
	args: {
		threadId: v.id('threadRecords'),
		browserbaseSessionId: v.string(),
		liveViewUrl: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('browserSessions')
			.withIndex('by_thread', (query) => query.eq('threadId', args.threadId))
			.first();
		// The session may have rotated while the URL was being fetched; stamping
		// the old session's URL onto the new row would point the live view at a
		// dead browser.
		if (
			existing &&
			existing.browserbaseSessionId === args.browserbaseSessionId &&
			!existing.liveViewUrl
		) {
			await ctx.db.patch(existing._id, { liveViewUrl: args.liveViewUrl });
		}
		return null;
	}
});
