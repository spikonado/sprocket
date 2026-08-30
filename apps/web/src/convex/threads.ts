import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { distinctOwnerKeys, getOwnerKeys } from '@convex/lib/auth';
import { vThreadSummary, vThreadWithUsageDoc } from '@convex/lib/docs';
import { getThreadUsageValues } from '@convex/lib/threadUsage';
import {
	isRunFinalStatus,
	vReasoningEffort,
	vRunStatus,
	vServiceTier
} from '@convex/lib/validators';

async function patchOwnedThread(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	patch: Partial<Doc<'threadRecords'>>
) {
	const keys = await getOwnerKeys(ctx);
	await getOwnedThreadRecord(ctx.db, keys, threadId);
	await ctx.db.patch('threadRecords', threadId, patch);
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
		const keys = await getOwnerKeys(ctx);
		const userId = keys.userId;
		const repositoryKey = args.repositoryKey.trim();
		if (repositoryKey.length === 0) {
			throw new Error('Repository key is required.');
		}
		let existingRecord = null;
		for (const key of distinctOwnerKeys(keys)) {
			existingRecord = await ctx.db
				.query('threadRecords')
				.withIndex('by_userId_submissionId', (query) =>
					query.eq('userId', key).eq('submissionId', args.submissionId)
				)
				.unique();
			if (existingRecord) break;
		}
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
			}

			let submissionRun = null;
			for (const key of distinctOwnerKeys(keys)) {
				submissionRun = await ctx.db
					.query('runs')
					.withIndex('by_userId_submissionId', (query) =>
						query.eq('userId', key).eq('submissionId', args.submissionId)
					)
					.unique();
				if (submissionRun) break;
			}

			return {
				threadId: existingRecord._id,
				submissionRunStatus: submissionRun?.status ?? null
			};
		}

		const now = Date.now();
		const recordId = await ctx.db.insert('threadRecords', {
			userId,
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

		return {
			threadId: recordId,
			submissionRunStatus: null
		};
	}
});

export const listMine = query({
	args: {},
	returns: v.array(vThreadSummary),
	handler: async (ctx) => {
		const keys = await getOwnerKeys(ctx);
		const records = (
			await Promise.all(
				distinctOwnerKeys(keys).map((key) =>
					ctx.db
						.query('threadRecords')
						.withIndex('by_userId_lastMessageAt', (query) => query.eq('userId', key))
						.order('desc')
						.collect()
				)
			)
		).flat();
		const summaries = await Promise.all(
			records.map(async (record) => {
				const latestRun = await ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', record._id))
					.order('desc')
					.first();
				return {
					...record,
					threadId: record._id,
					repositoryKey: record.repositoryKey ?? '',
					title: record.title?.trim() || 'New thread',
					threadStatus:
						record.archivedAt !== undefined ? ('archived' as const) : ('active' as const),
					latestRunStatus: latestRun?.status ?? null,
					latestRunId: latestRun?._id ?? null,
					latestRunStartedAt: latestRun?.startedAt,
					latestRunClaimExpiresAt: latestRun?.claimExpiresAt,
					hasActiveRun: latestRun ? !isRunFinalStatus(latestRun.status) : false
				};
			})
		);
		// Running threads first, then most recently active. The index already
		// returns lastMessageAt-desc, so the comparator only needs to promote
		// active runs while staying stable for the rest.
		return summaries.sort((left, right) => {
			const active = Number(right.hasActiveRun) - Number(left.hasActiveRun);
			if (active !== 0) return active;
			return right.lastMessageAt - left.lastMessageAt;
		});
	}
});

export const getByThreadId = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: vThreadWithUsageDoc,
	handler: async (ctx, args) => {
		const keys = await getOwnerKeys(ctx);
		const thread = await getOwnedThreadRecord(ctx.db, keys, args.threadId);
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
		const title = args.title.trim();
		if (title.length === 0) {
			throw new Error('Thread title cannot be empty.');
		}
		await patchOwnedThread(ctx, args.threadId, { title });
	}
});

export const archive = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const keys = await getOwnerKeys(ctx);
		await getOwnedThreadRecord(ctx.db, keys, args.threadId);

		for (const status of ['queued', 'running', 'awaiting_executor'] as const) {
			const activeRun = await ctx.db
				.query('runs')
				.withIndex('by_threadId_status_startedAt', (query) =>
					query.eq('threadId', args.threadId).eq('status', status)
				)
				.first();
			if (activeRun) {
				throw new Error('Cannot archive a thread while a run is active.');
			}
		}

		await ctx.db.patch('threadRecords', args.threadId, { archivedAt: Date.now() });
	}
});

export const restore = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await patchOwnedThread(ctx, args.threadId, { archivedAt: undefined });
	}
});

export const rekeyRepository = mutation({
	args: {
		from: v.string(),
		to: v.string()
	},
	returns: v.number(),
	handler: async (ctx, args) => {
		const from = args.from.trim();
		const to = args.to.trim();
		if (from.length === 0 || to.length === 0) {
			throw new Error('Repository key is required.');
		}
		if (from === to) {
			return 0;
		}

		const keys = await getOwnerKeys(ctx);
		const threads = (
			await Promise.all(
				[keys.userId, keys.subject]
					.filter((key, index, all) => all.indexOf(key) === index)
					.map((key) =>
						ctx.db
							.query('threadRecords')
							.withIndex('by_userId_repositoryKey', (query) =>
								query.eq('userId', key).eq('repositoryKey', from)
							)
							.collect()
					)
			)
		).flat();
		for (const thread of threads) {
			await ctx.db.patch('threadRecords', thread._id, { repositoryKey: to });
		}
		return threads.length;
	}
});
