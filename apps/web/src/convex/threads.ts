import type { Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { vThreadSummary, vThreadWithUsageDoc } from '@convex/lib/docs';
import { getThreadUsageValues } from '@convex/lib/threadUsage';
import {
	bumpThreadSnapshotForRecord,
	bumpThreadSnapshotRevisions,
	readSnapshotRevision,
	summarizeThreadRecord,
	vThreadSnapshotCategory
} from '@convex/lib/threadSnapshots';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { vReasoningEffort, vRunStatus, vServiceTier } from '@convex/lib/validators';

async function renameOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>, title: string) {
	const trimmedTitle = title.trim();
	if (trimmedTitle.length === 0) {
		throw new Error('Thread title cannot be empty.');
	}
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);
	await ctx.db.patch('threadRecords', threadId, { title: trimmedTitle });
	await bumpThreadSnapshotForRecord(ctx, record);
	return { userId, record };
}

async function archiveOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);

	for (const status of ['queued', 'running', 'awaiting_executor'] as const) {
		const activeRun = await ctx.db
			.query('runs')
			.withIndex('by_threadId_status_startedAt', (query) =>
				query.eq('threadId', threadId).eq('status', status)
			)
			.first();
		if (activeRun) {
			throw new Error('Cannot archive a thread while a run is active.');
		}
	}

	await ctx.db.patch('threadRecords', threadId, { archivedAt: Date.now() });
	await bumpThreadSnapshotRevisions(ctx, {
		userId,
		repositoryKey: record.repositoryKey ?? '',
		categories: ['active', 'archived']
	});
	return { userId, record };
}

async function restoreOwnedThread(ctx: MutationCtx, threadId: Id<'threadRecords'>) {
	const userId = await getUserId(ctx);
	const record = await getOwnedThreadRecord(ctx.db, userId, threadId);
	await ctx.db.patch('threadRecords', threadId, { archivedAt: undefined });
	await bumpThreadSnapshotRevisions(ctx, {
		userId,
		repositoryKey: record.repositoryKey ?? '',
		categories: ['active', 'archived']
	});
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
	if (threads.length > 0) {
		await bumpThreadSnapshotRevisions(ctx, {
			userId,
			repositoryKey: from,
			categories: ['active', 'archived']
		});
		await bumpThreadSnapshotRevisions(ctx, {
			userId,
			repositoryKey: to,
			categories: ['active', 'archived']
		});
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
		const userId = await getUserId(ctx);
		const repositoryKey = args.repositoryKey.trim();
		if (repositoryKey.length === 0) {
			throw new Error('Repository key is required.');
		}
		const existingRecord = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_submissionId', (query) =>
				query.eq('userId', userId).eq('submissionId', args.submissionId)
			)
			.unique();
		if (existingRecord) {
			if (
				existingRecord.repositoryKey !== repositoryKey ||
				existingRecord.selectedModel !== args.selectedModel ||
				existingRecord.reasoningEffort !== args.reasoningEffort ||
				existingRecord.serviceTier !== args.serviceTier
			) {
				throw new Error('Submission settings do not match the existing thread.');
			}

			if (existingRecord.archivedAt !== undefined) {
				await ctx.db.patch('threadRecords', existingRecord._id, { archivedAt: undefined });
				await bumpThreadSnapshotRevisions(ctx, {
					userId,
					repositoryKey,
					categories: ['active', 'archived']
				});
			}

			const submissionRun = await ctx.db
				.query('runs')
				.withIndex('by_userId_submissionId', (query) =>
					query.eq('userId', userId).eq('submissionId', args.submissionId)
				)
				.unique();

			return {
				threadId: existingRecord._id,
				submissionRunStatus: submissionRun?.status ?? null
			};
		}

		const now = Date.now();
		const recordId = await ctx.db.insert('threadRecords', {
			userId: userId,
			submissionId: args.submissionId,
			repositoryKey,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier,
			lastMessageAt: now
		});
		await ctx.db.insert('threadUsage', {
			threadId: recordId,
			userId,
			totalTokensProcessed: 0
		});
		await bumpThreadSnapshotRevisions(ctx, {
			userId,
			repositoryKey,
			categories: ['active']
		});

		return {
			threadId: recordId,
			submissionRunStatus: null
		};
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

export const getSnapshotRevision = query({
	args: {
		repositoryKey: v.string(),
		category: vThreadSnapshotCategory
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const repositoryKey = args.repositoryKey.trim();
		if (repositoryKey.length === 0) {
			throw new Error('Repository key is required.');
		}
		return await readSnapshotRevision(ctx, {
			userId,
			repositoryKey,
			category: args.category
		});
	}
});

export const listSnapshotPage = query({
	args: {
		repositoryKey: v.string(),
		category: vThreadSnapshotCategory,
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(vThreadSummary),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const repositoryKey = args.repositoryKey.trim();
		if (repositoryKey.length === 0) {
			throw new Error('Repository key is required.');
		}
		const result = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_and_repositoryKey_and_archivedAt_and_lastMessageAt', (query) => {
				const scoped = query.eq('userId', userId).eq('repositoryKey', repositoryKey);
				return args.category === 'active'
					? scoped.eq('archivedAt', undefined)
					: scoped.gt('archivedAt', 0);
			})
			.order('desc')
			.paginate(args.paginationOpts);
		return {
			...result,
			page: await Promise.all(result.page.map((record) => summarizeThreadRecord(ctx, record)))
		};
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
		repositoryKey: v.string(),
		category: vThreadSnapshotCategory
	}),
	handler: async (ctx, args) => {
		const { userId, record } = await renameOwnedThread(ctx, args.threadId, args.title);
		return {
			userId,
			repositoryKey: record.repositoryKey ?? '',
			category: record.archivedAt === undefined ? ('active' as const) : ('archived' as const)
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
