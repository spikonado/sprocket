import { v, type Infer } from 'convex/values';
import { action, internalMutation, internalQuery } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { vBrowserSessionResult } from '@convex/lib/validators';

/** Public entry: delegates to the Node-runtime internal action that drives the
 * Browserbase SDK. Kept as a separate module because the SDK's Node deps
 * (node-fetch, agentkeepalive) cannot load in the default Convex runtime. */
export const start = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vBrowserSessionResult,
	handler: async (ctx, args): Promise<Infer<typeof vBrowserSessionResult>> => {
		return await ctx.runAction(internal.browserSessionsNode.startInternal, args);
	}
});

const browserSessionDoc = v.object({
	_id: v.id('browserSessions'),
	_creationTime: v.number(),
	runId: v.id('runs'),
	userId: v.string(),
	browserbaseSessionId: v.string(),
	liveViewUrl: v.string(),
	startedAt: v.number()
});

export const getForRun = internalQuery({
	args: { runId: v.id('runs'), userId: v.string() },
	returns: v.union(browserSessionDoc, v.null()),
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query('browserSessions')
			.withIndex('by_run', (query) => query.eq('runId', args.runId))
			.first();
		return session?.userId === args.userId ? session : null;
	}
});

export const remove = internalMutation({
	args: { id: v.id('browserSessions') },
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.delete(args.id);
		return null;
	}
});

export const insert = internalMutation({
	args: {
		runId: v.id('runs'),
		userId: v.string(),
		browserbaseSessionId: v.string(),
		liveViewUrl: v.string()
	},
	returns: v.id('browserSessions'),
	handler: async (ctx, args) => {
		return await ctx.db.insert('browserSessions', {
			...args,
			startedAt: Date.now()
		});
	}
});
