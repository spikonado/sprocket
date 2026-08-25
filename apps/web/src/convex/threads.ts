import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord, getOwnedProject } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import { vThreadSummary, vThreadWithUsageDoc } from '@convex/lib/docs';
import { getThreadUsageValues } from '@convex/lib/threadUsage';
import { assertModelConfigurationAllowedForUser } from '@convex/lib/tiers';
import {
	isRunFinalStatus,
	vModelId,
	vReasoningEffort,
	vRunStatus,
	vServiceTier
} from '@convex/lib/validators';

async function patchOwnedThread(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	patch: Partial<Doc<'threadRecords'>>
) {
	const userId = await getUserId(ctx);
	await getOwnedThreadRecord(ctx.db, userId, threadId);
	await ctx.db.patch('threadRecords', threadId, patch);
}

export const create = mutation({
	args: {
		submissionId: v.string(),
		projectId: v.id('projects'),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier
	},
	returns: v.object({
		threadId: v.id('threadRecords'),
		submissionRunStatus: v.union(vRunStatus, v.null())
	}),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await assertModelConfigurationAllowedForUser(ctx, userId, {
			modelId: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier
		});
		await getOwnedProject(ctx.db, userId, args.projectId);
		const existingRecord = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_submissionId', (query) =>
				query.eq('userId', userId).eq('submissionId', args.submissionId)
			)
			.unique();
		if (existingRecord) {
			if (
				existingRecord.projectId !== args.projectId ||
				existingRecord.selectedModel !== args.selectedModel ||
				existingRecord.reasoningEffort !== args.reasoningEffort ||
				existingRecord.serviceTier !== args.serviceTier
			) {
				throw new Error('Submission settings do not match the existing thread.');
			}

			if (existingRecord.archivedAt !== undefined) {
				await ctx.db.patch('threadRecords', existingRecord._id, { archivedAt: undefined });
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
			projectId: args.projectId,
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
		const userId = await getUserId(ctx);
		const records = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_lastMessageAt', (query) => query.eq('userId', userId))
			.order('desc')
			.collect();
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
		return summaries.sort((left, right) => Number(right.hasActiveRun) - Number(left.hasActiveRun));
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
		const usage = await getThreadUsageValues(ctx.db, thread);
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
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

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
