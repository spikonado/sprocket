import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord, getOwnedWorkspaceSession } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import {
	assertSupportedModelConfiguration,
	normalizeModelId,
	normalizeServiceTier
} from '@convex/lib/models';
import { isRunFinalStatus, vModelId, vReasoningEffort, vServiceTier } from '@convex/lib/validators';

async function patchOwnedThread(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	patch: Partial<Doc<'threadRecords'>>
) {
	const userId = await getUserId(ctx);
	await getOwnedThreadRecord(ctx.db, userId, threadId);
	await ctx.db.patch(threadId, patch);
}

export const create = mutation({
	args: {
		submissionId: v.string(),
		workspaceSessionId: v.id('workspaceSessions'),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier
	},
	handler: async (
		ctx,
		args
	): Promise<{
		threadId: Id<'threadRecords'>;
		submissionRunStatus: Doc<'runs'>['status'] | null;
	}> => {
		assertSupportedModelConfiguration({
			modelId: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier
		});
		const userId: string = await getUserId(ctx);
		await getOwnedWorkspaceSession(ctx.db, userId, args.workspaceSessionId);
		const existingRecord = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_submissionId', (query) =>
				query.eq('userId', userId).eq('submissionId', args.submissionId)
			)
			.unique();
		if (existingRecord) {
			if (
				existingRecord.workspaceSessionId !== args.workspaceSessionId ||
				normalizeModelId(existingRecord.selectedModel) !== args.selectedModel ||
				existingRecord.reasoningEffort !== args.reasoningEffort ||
				normalizeServiceTier(existingRecord.serviceTier) !== args.serviceTier
			) {
				throw new Error('Submission settings do not match the existing thread.');
			}

			if (existingRecord.archivedAt !== undefined) {
				await ctx.db.patch(existingRecord._id, { archivedAt: undefined });
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
			workspaceSessionId: args.workspaceSessionId,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			serviceTier: args.serviceTier,
			lastMessageAt: now
		});

		return {
			threadId: recordId,
			submissionRunStatus: null
		};
	}
});

export const listMine = query({
	args: {},
	handler: async (ctx) => {
		const userId: string = await getUserId(ctx);
		const [records, workspaceSessions] = await Promise.all([
			ctx.db
				.query('threadRecords')
				.withIndex('by_userId_lastMessageAt', (query) => query.eq('userId', userId))
				.order('desc')
				.collect(),
			ctx.db
				.query('workspaceSessions')
				.withIndex('by_userId', (query) => query.eq('userId', userId))
				.collect()
		]);
		const workspaceSessionLookup = new Map(
			workspaceSessions.map((workspaceSession) => [workspaceSession._id, workspaceSession])
		);
		return await Promise.all(
			records.map(async (record) => {
				const workspaceSession = workspaceSessionLookup.get(record.workspaceSessionId);
				const latestRun = await ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', record._id))
					.order('desc')
					.first();
				return {
					...record,
					selectedModel: normalizeModelId(record.selectedModel),
					serviceTier: normalizeServiceTier(record.serviceTier),
					threadId: record._id,
					title: record.title?.trim() || 'New thread',
					threadStatus:
						record.archivedAt !== undefined ? ('archived' as const) : ('active' as const),
					workspaceName: workspaceSession?.workspaceName ?? 'Unknown workspace',
					latestRunStatus: latestRun?.status ?? null,
					latestRunId: latestRun?._id ?? null,
					latestRunStartedAt: latestRun?.startedAt,
					latestRunClaimExpiresAt: latestRun?.claimExpiresAt,
					hasActiveRun: latestRun ? !isRunFinalStatus(latestRun.status) : false
				};
			})
		);
	}
});

export const getByThreadId = query({
	args: {
		threadId: v.id('threadRecords')
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx);
		const record = await getOwnedThreadRecord(ctx.db, userId, args.threadId);
		return {
			...record,
			selectedModel: normalizeModelId(record.selectedModel),
			serviceTier: normalizeServiceTier(record.serviceTier)
		};
	}
});

export const rename = mutation({
	args: {
		threadId: v.id('threadRecords'),
		title: v.string()
	},
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
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const runs = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.collect();
		if (runs.some((run) => !isRunFinalStatus(run.status))) {
			throw new Error('Cannot archive a thread while a run is active.');
		}

		await ctx.db.patch(args.threadId, { archivedAt: Date.now() });
	}
});

export const restore = mutation({
	args: {
		threadId: v.id('threadRecords')
	},
	handler: async (ctx, args) => {
		await patchOwnedThread(ctx, args.threadId, { archivedAt: undefined });
	}
});
