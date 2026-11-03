import type { Id } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import { internalMutation, mutation, query, type MutationCtx } from '@convex/_generated/server';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { vDescendantStatusCounts } from '@convex/lib/validators';
import schema from '@convex/schema';
import {
	listDirectChildrenPage,
	subtreeSummary,
	threadAncestryIds
} from '@convex/lib/threadHierarchy';

async function renameOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>, title: string) {
	const trimmedTitle = title.trim();

	if (trimmedTitle.length === 0) {
		throw new Error('Thread title cannot be empty.');
	}

	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);
	await ctx.db.patch('threadRecords', threadId, {
		title: trimmedTitle,
		titleRenameKey: crypto.randomUUID()
	});

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

export const getByThreadId = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: schema.doc('threadRecords'),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);

		return await getOwnedThreadRecord(ctx.db, userId, args.threadId);
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

export const moveToProject = mutation({
	args: {
		threadId: v.id('threadRecords'),
		repositoryKey: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const repositoryKey = args.repositoryKey.trim();

		if (!repositoryKey) {
			throw new Error('Repository key is required.');
		}

		const userId = await getUserId(ctx);
		const record = await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		if (record.parentThreadId !== undefined) {
			throw new Error('Only root threads can be moved.');
		}

		if (record.repositoryKey === repositoryKey) return null;

		const summary = await subtreeSummary(ctx.db, record);

		if (summary.anyActive) {
			throw new Error('Cannot move a thread with active work.');
		}

		// The saved cwd points into the old project, so runs restart at the new root.
		await ctx.db.patch('threadRecords', args.threadId, { repositoryKey, cwd: undefined });

		if (summary.descendantCount > 0) {
			await ctx.scheduler.runAfter(0, internal.threads.moveDescendants, {
				parentThreadId: args.threadId,
				cursor: null
			});
		}

		return null;
	}
});

// Children copy their parent's current project, so overlapping moves converge on the latest one.
export const moveDescendants = internalMutation({
	args: {
		parentThreadId: v.id('threadRecords'),
		cursor: v.union(v.string(), v.null())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const parent = await ctx.db.get('threadRecords', args.parentThreadId);

		if (!parent) return null;

		const result = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_parentThreadId', (q) =>
				q.eq('userId', parent.userId).eq('parentThreadId', parent._id)
			)
			.paginate({ numItems: 64, cursor: args.cursor });

		for (const child of result.page) {
			await ctx.db.patch('threadRecords', child._id, {
				repositoryKey: parent.repositoryKey,
				cwd: undefined
			});
			await ctx.scheduler.runAfter(0, internal.threads.moveDescendants, {
				parentThreadId: child._id,
				cursor: null
			});
		}

		if (!result.isDone) {
			await ctx.scheduler.runAfter(0, internal.threads.moveDescendants, {
				parentThreadId: args.parentThreadId,
				cursor: result.continueCursor
			});
		}

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

const vSubtreeSummary = v.object({
	workingDescendantCount: v.number(),
	descendantCount: v.number(),
	descendantStatusCounts: vDescendantStatusCounts,
	anyActive: v.boolean(),
	descendantsActive: v.boolean()
});

export const subtreeSummaryForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vSubtreeSummary,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		return await subtreeSummary(ctx.db, thread);
	}
});

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
