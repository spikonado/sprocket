import type { Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import { rekeyOwnedArtifacts } from '@convex/artifacts';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { vThreadWithUsageDoc } from '@convex/lib/docs';
import { getThreadUsageValues } from '@convex/lib/threadUsage';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { vReasoningEffort, vRunStatus } from '@convex/lib/validators';

async function renameOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>, title: string) {
	const trimmedTitle = title.trim();
	if (trimmedTitle.length === 0) {
		throw new Error('Thread title cannot be empty.');
	}
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);
	await ctx.db.patch('threadRecords', threadId, { title: trimmedTitle });
	return { userId, record };
}

async function settleOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);

	if (record.status === 'running') {
		throw new Error('Cannot settle a running thread.');
	}

	await ctx.db.patch('threadRecords', threadId, { archivedAt: Date.now() });
	return { userId, record };
}

async function unsettleOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);
	await ctx.db.patch('threadRecords', threadId, { archivedAt: undefined });
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
		await ctx.db.patch('threadRecords', thread._id, { repositoryKey: to });
	}
	await rekeyOwnedArtifacts(ctx, userId, from, to);
	return { userId, from, to, count: threads.length };
}

export const create = mutation({
	args: {
		submissionId: v.string(),
		repositoryKey: v.string(),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: v.string()
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

		await ctx.db.patch('threadRecords', thread._id, { selectedModel: args.selectedModel });
		return null;
	}
});

/** Retired UI listing. Current clients read the paginated inbox. */
export const listMine = query({
	args: {},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
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

export const rename = mutation({
	args: {
		threadId: v.id('threadRecords'),
		title: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await renameOwnedThread(ctx, args.threadId, args.title);
		return null;
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
			repositoryKey: record.repositoryKey
		};
	}
});

/** Retired archive terminology. Current clients call `settle`. */
export const archive = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const settle = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await settleOwnedThread(ctx, args.threadId);
		return null;
	}
});

/** Compatibility for released local servers using archive terminology. */
export const archiveForLocalCache = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.object({ userId: v.string(), repositoryKey: v.string() }),
	handler: async (ctx, args) => {
		const { userId, record } = await settleOwnedThread(ctx, args.threadId);
		return { userId, repositoryKey: record.repositoryKey };
	}
});

/** Retired restore terminology. Current clients call `unsettle`. */
export const restore = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const unsettle = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await unsettleOwnedThread(ctx, args.threadId);
		return null;
	}
});

/** Compatibility for released local servers using restore terminology. */
export const restoreForLocalCache = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.object({ userId: v.string(), repositoryKey: v.string() }),
	handler: async (ctx, args) => {
		const { userId, record } = await unsettleOwnedThread(ctx, args.threadId);
		return { userId, repositoryKey: record.repositoryKey };
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
