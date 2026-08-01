import { v } from 'convex/values';
import { internalMutation, internalQuery } from '@convex/_generated/server';

const browserSessionDoc = v.object({
	_id: v.id('browserSessions'),
	_creationTime: v.number(),
	runId: v.id('runs'),
	userId: v.string(),
	browserbaseSessionId: v.string(),
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

export const insert = internalMutation({
	args: {
		runId: v.id('runs'),
		userId: v.string(),
		browserbaseSessionId: v.string()
	},
	returns: v.id('browserSessions'),
	handler: async (ctx, args) => {
		return await ctx.db.insert('browserSessions', {
			...args,
			startedAt: Date.now()
		});
	}
});
