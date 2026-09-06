import type { Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import schema from '@convex/schema';
import { vThreadWithUsageDoc } from '@convex/lib/docs';
import { getThreadUsageValues } from '@convex/lib/threadUsage';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { vReasoningEffort, vRunStatus, vServiceTier } from '@convex/lib/validators';

async function renameOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>, title: string) {
	const trimmedTitle = title.trim();
	if (trimmedTitle.length === 0) {
		throw new Error('Thread title cannot be empty.');
	}
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);
	await ctx.db.patch('threadRecords', threadId, { title: trimmedTitle, updatedAt: Date.now() });
	return { userId, record };
}

async function archiveOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);

	if (record.status && ['queued', 'running', 'awaiting_executor'].includes(record.status)) {
		throw new Error('Cannot archive a thread while a run is active.');
	}

	await ctx.db.patch('threadRecords', threadId, { archivedAt: Date.now(), updatedAt: Date.now() });
	return { userId, record };
}

async function restoreOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);
	await ctx.db.patch('threadRecords', threadId, { archivedAt: undefined, updatedAt: Date.now() });
	return { userId, record };
}

async function rekeyOwnedThreads(ctx: MutationCtx, fromArg: string, toArg: string) {
	const userId = await getUserId(ctx);
	const from = fromArg.trim();
	const to = toArg.trim();
	if (from.length === 0 || to.length === 0) {
		throw new Error('Repository key is required.');
	}
	if (from === to) {
		return { userId, from, to, count: 0 };
	}

	const threads = await ctx.db
		.query('threadRecords')
		.withIndex('by_userId_repositoryKey', (query) =>
			query.eq('userId', userId).eq('repositoryKey', from)
		)
		.collect();
	for (const thread of threads) {
		await ctx.db.patch('threadRecords', thread._id, { repositoryKey: to, updatedAt: Date.now() });
	}
	return { userId, from, to, count: threads.length };
}

export const create = mutation({
	args: {
		submissionId: v.string(),
		repositoryKey: v.string(),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier
	},
	returns: v.object({
		threadId: v.id('threadRecords'),
		submissionRunStatus: v.union(vRunStatus, v.null())
	}),
	handler: async (ctx, args) => {
		void ctx;
		void args;
		return unsupportedClient();
	}
});

export const setSelectedModel = mutation({
	args: {
		threadId: v.id('threadRecords'),
		selectedModel: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		if (thread.selectedModel === args.selectedModel) {
			return null;
		}

		await ctx.db.patch('threadRecords', thread._id, {
			selectedModel: args.selectedModel,
			updatedAt: Date.now()
		});
		return null;
	}
});

/** Retired UI listing. Current clients read the local summary cache. */
export const listMine = query({
	args: {},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const listRecent = query({
	args: {
		selectedThreadId: v.optional(v.id('threadRecords'))
	},
	returns: v.array(schema.doc('threadRecords')),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const recent = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_lastMessageAt', (query) => query.eq('userId', userId))
			.order('desc')
			.take(15);
		if (!args.selectedThreadId || recent.some((thread) => thread._id === args.selectedThreadId)) {
			return recent;
		}

		const selected = await ctx.db.get('threadRecords', args.selectedThreadId);
		return selected?.userId === userId ? [...recent, selected] : recent;
	}
});

export const getByThreadId = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vThreadWithUsageDoc,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		const usage = await getThreadUsageValues(ctx, thread);
		return { ...thread, ...usage };
	}
});

/** Retired direct Convex command. Current clients use the local thread routes. */
export const rename = mutation({
	args: {
		threadId: v.id('threadRecords'),
		title: v.string()
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const renameForLocalCache = mutation({
	args: {
		threadId: v.id('threadRecords'),
		title: v.string()
	},
	returns: v.object({
		userId: v.string(),
		repositoryKey: v.string()
	}),
	handler: async (ctx, args) => {
		const { userId, record } = await renameOwnedThread(ctx, args.threadId, args.title);
		return {
			userId,
			repositoryKey: record.repositoryKey ?? ''
		};
	}
});

/** Retired direct Convex command. Current clients use the local thread routes. */
export const archive = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const archiveForLocalCache = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.object({ userId: v.string(), repositoryKey: v.string() }),
	handler: async (ctx, args) => {
		const { userId, record } = await archiveOwnedThread(ctx, args.threadId);
		return { userId, repositoryKey: record.repositoryKey ?? '' };
	}
});

/** Retired direct Convex command. Current clients use the local thread routes. */
export const restore = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const restoreForLocalCache = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.object({ userId: v.string(), repositoryKey: v.string() }),
	handler: async (ctx, args) => {
		const { userId, record } = await restoreOwnedThread(ctx, args.threadId);
		return { userId, repositoryKey: record.repositoryKey ?? '' };
	}
});

/** Retired direct Convex command. Current clients use the local thread routes. */
export const rekeyRepository = mutation({
	args: {
		from: v.string(),
		to: v.string()
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const rekeyRepositoryForLocalCache = mutation({
	args: {
		from: v.string(),
		to: v.string()
	},
	returns: v.object({ userId: v.string(), from: v.string(), to: v.string(), count: v.number() }),
	handler: async (ctx, args) => await rekeyOwnedThreads(ctx, args.from, args.to)
});
