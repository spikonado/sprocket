import type { Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { vCompletionProvider } from '@convex/lib/validators';
import { vThreadWithUsageDoc } from '@convex/lib/docs';
import { getThreadUsageValues } from '@convex/lib/threadUsage';
import schema from '@convex/schema';
import {
	listDirectChildrenPage,
	subtreeSummary,
	threadAncestryIds,
	threadDescendantsActive
} from '@convex/lib/threadHierarchy';

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

	if (record.parentThreadId !== undefined) {
		throw new Error('Only root threads can be settled.');
	}

	if ((await subtreeSummary(ctx.db, record)).anyActive) {
		throw new Error('Cannot settle a thread with active work.');
	}

	await ctx.db.patch('threadRecords', threadId, { archivedAt: Date.now() });

	return { userId, record };
}

async function unsettleOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);

	if (record.parentThreadId !== undefined) {
		throw new Error('Only root threads can be settled.');
	}

	await ctx.db.patch('threadRecords', threadId, { archivedAt: undefined });

	return { userId, record };
}

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

export const setCompletionSettings = mutation({
	args: {
		threadId: v.id('threadRecords'),
		selectedModel: v.string(),
		completionProvider: vCompletionProvider
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		if (
			thread.selectedModel === args.selectedModel &&
			(thread.completionProvider ?? 'spikonado') === args.completionProvider
		) {
			return null;
		}

		await ctx.db.patch('threadRecords', thread._id, {
			selectedModel: args.selectedModel,
			completionProvider: args.completionProvider
		});

		return null;
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

export const listChildren = query({
	args: {
		threadId: v.id('threadRecords'),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(schema.doc('threadRecords')),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		return await listDirectChildrenPage(ctx, userId, args.threadId, args.paginationOpts);
	}
});

export const vSubtreeSummary = v.object({
	descendantCount: v.number(),
	anyActive: v.boolean(),
	descendantsActive: v.boolean()
});

/** All-descendant count and aggregate activity for the sidebar expansion
 * row. The caller may pass any owned thread; counts cover its full subtree. */
export const subtreeSummaryForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vSubtreeSummary,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		return {
			...(await subtreeSummary(ctx.db, thread)),
			descendantsActive: await threadDescendantsActive(ctx.db, thread._id)
		};
	}
});

/** Ancestor chain from the root down to (and excluding) the given thread, so
 * selecting a child can reveal its ancestors in the sidebar. */
export const ancestorChain = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.array(v.id('threadRecords')),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		if (thread.parentThreadId === undefined) return [];

		return await threadAncestryIds(ctx.db, thread);
	}
});

export const rekeyRepository = mutation({
	args: {
		from: v.string(),
		to: v.string()
	},
	returns: v.object({ userId: v.string(), from: v.string(), to: v.string(), count: v.number() }),
	handler: async (ctx, args) => ({
		userId: await getUserId(ctx),
		from: args.from.trim(),
		to: args.to.trim(),
		count: 0
	})
});
