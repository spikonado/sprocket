import type { Doc, Id } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import {
	internalMutation,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import {
	findOwnedThreadRecord,
	getOwnedThreadRecord,
	getOwnedThreadRecordByString
} from '@convex/lib/access';
import { getExecutionRunRecord, getUserId } from '@convex/lib/auth';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';
import { INBOX_STATES, type InboxState } from '@convex/lib/inboxState';
import schema from '@convex/schema';
import { deleteThread, deleteThreadDataBatch } from '@convex/lib/threadDeletion';
import {
	listDirectChildrenPage,
	settleRoot,
	subtreeSummary,
	threadAncestryIds,
	unsettleRoot
} from '@convex/lib/threadHierarchy';
import {
	rootThreadsPage,
	searchChildThreads,
	searchRootThreads,
	threadSummary
} from '@convex/lib/threadListing';
import { vListThreadsPayload, vListThreadsResult } from '@convex/lib/validators';

const MAX_ATOMIC_MOVE_DESCENDANTS = 1000;
const AGENT_LIST_PAGE_SIZE = 32;

type RootListCursor = { state: InboxState; cursor: string | null };

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

export const getByThreadId = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.union(schema.doc('threadRecords'), v.null()),
	handler: async (ctx, args) =>
		await findOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId)
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
		const record = await getOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId);

		if (!(await settleRoot(ctx, record))) {
			throw new Error('Cannot settle a thread with active work.');
		}

		return null;
	}
});

export const unsettle = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const record = await getOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId);

		if (record.parentThreadId !== undefined) {
			throw new Error('Only root threads can be settled.');
		}

		await unsettleRoot(ctx, record);

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

		if (summary.descendantCount > MAX_ATOMIC_MOVE_DESCENDANTS) {
			throw new Error('This thread has too many subagents to move.');
		}

		const pending: Id<'threadRecords'>[] = [args.threadId];

		while (pending.length > 0) {
			const threadId = pending.pop()!;

			await ctx.db.patch('threadRecords', threadId, { repositoryKey, cwd: undefined });

			const children = ctx.db
				.query('threadRecords')
				.withIndex('by_userId_parentThreadId', (q) =>
					q.eq('userId', userId).eq('parentThreadId', threadId)
				);

			for await (const child of children) pending.push(child._id);
		}

		return null;
	}
});

export const remove = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const record = await getOwnedThreadRecord(ctx.db, await getUserId(ctx), args.threadId);

		if (record.parentThreadId !== undefined) {
			throw new Error('Only root threads can be deleted.');
		}

		if ((await subtreeSummary(ctx.db, record)).anyActive) {
			throw new ConvexError('Stop the thread before deleting it.');
		}

		await deleteThread(ctx, record);

		return null;
	}
});

export const deleteThreadData = internalMutation({
	args: {
		threadId: v.id('threadRecords'),
		userId: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (!(await deleteThreadDataBatch(ctx, args))) {
			await ctx.scheduler.runAfter(0, internal.threads.deleteThreadData, args);
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
	anyActive: v.boolean(),
	descendantsActive: v.boolean(),
	waitingForInput: v.boolean()
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

function parseRootCursor(cursor: string | undefined): RootListCursor {
	if (cursor === undefined) return { state: 'unsettled', cursor: null };

	const separator = cursor.indexOf(':');
	const state = INBOX_STATES.find((candidate) => candidate === cursor.slice(0, separator));

	if (separator < 0 || !state) throw new Error('Invalid cursor.');

	return { state, cursor: cursor.slice(separator + 1) || null };
}

function formatRootCursor(position: RootListCursor) {
	return `${position.state}:${position.cursor ?? ''}`;
}

async function summaries(ctx: QueryCtx, threads: Doc<'threadRecords'>[]) {
	return await Promise.all(threads.map((thread) => threadSummary(ctx, thread)));
}

/** Lists or searches the run's user's threads for the `list_threads` agent tool. */
export const listForRun = query({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		...vListThreadsPayload.fields
	},
	returns: vListThreadsResult,
	handler: async (ctx, args) => {
		try {
			const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);
			const search = args.query?.trim();

			if (args.parentThreadId !== undefined) {
				const parent = await getOwnedThreadRecordByString(ctx.db, run.userId, args.parentThreadId);

				if (search) {
					return {
						threads: await summaries(ctx, await searchChildThreads(ctx, parent, search)),
						nextCursor: null
					};
				}

				const page = await listDirectChildrenPage(ctx, run.userId, parent._id, {
					numItems: AGENT_LIST_PAGE_SIZE,
					cursor: args.cursor ?? null
				});

				return {
					threads: await summaries(ctx, page.page),
					nextCursor: page.isDone ? null : page.continueCursor
				};
			}

			const repositoryKeys = args.repositoryKeys ?? [
				(await getOwnedThreadRecord(ctx.db, run.userId, run.threadId)).repositoryKey
			];

			const includeSettled = args.includeSettled ?? false;
			const states: readonly InboxState[] = includeSettled ? INBOX_STATES : ['unsettled'];

			if (search) {
				const roots = await searchRootThreads(ctx, run.userId, search, repositoryKeys, states);

				return { threads: await summaries(ctx, roots), nextCursor: null };
			}

			const readPage = async (position: RootListCursor) =>
				await rootThreadsPage(ctx, run.userId, position.state, repositoryKeys, {
					numItems: AGENT_LIST_PAGE_SIZE,
					cursor: position.cursor
				});

			let position = parseRootCursor(args.cursor);
			let page = await readPage(position);

			if (
				page.isDone &&
				page.page.length === 0 &&
				position.state === 'unsettled' &&
				includeSettled
			) {
				position = { state: 'settled', cursor: null };
				page = await readPage(position);
			}

			const next: RootListCursor | null = !page.isDone
				? { state: position.state, cursor: page.continueCursor }
				: position.state === 'unsettled' && includeSettled
					? { state: 'settled', cursor: null }
					: null;

			return {
				threads: await summaries(ctx, page.page),
				nextCursor: next && formatRootCursor(next)
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});
