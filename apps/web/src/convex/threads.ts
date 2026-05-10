import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord, getOwnedWorkspaceSession } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import {
	enforceGuestThreadCreateLimit,
	enforceSignedInThreadCreateLimit
} from '@convex/lib/rateLimits';
import { isActiveRunStatus } from '@convex/lib/runs';
import { listThreadMessages } from '@convex/lib/threadMessages';
import { vModelId, vReasoningEffort } from '@convex/lib/validators';

export const create = mutation({
	args: {
		guestId: v.optional(v.string()),
		workspaceSessionId: v.id('workspaceSessions'),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		if (userId.startsWith('guest:')) {
			await enforceGuestThreadCreateLimit(ctx, userId);
		} else {
			await enforceSignedInThreadCreateLimit(ctx, userId);
		}
		const workspaceSession = await getOwnedWorkspaceSession(
			ctx.db,
			userId,
			args.workspaceSessionId
		);

		const now = Date.now();
		const recordId = await ctx.db.insert('threadRecords', {
			userId: userId,
			workspaceSessionId: args.workspaceSessionId,
			workspacePath: workspaceSession.workspacePath,
			workspaceName: workspaceSession.workspaceName,
			summary: workspaceSession.workspacePath,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			nextMessageOrder: 0,
			lastMessageAt: now
		});

		return {
			threadId: recordId
		};
	}
});

export const listMine = query({
	args: {
		guestId: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const records = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_lastMessageAt', (query) => query.eq('userId', userId))
			.order('desc')
			.collect();
		return await Promise.all(
			records.map(async (record) => {
				const latestRun = await ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', record._id))
					.order('desc')
					.first();
				return {
					...record,
					threadId: record._id,
					threadStatus: 'active',
					workspaceName: record.workspaceName ?? record.workspacePath,
					latestRunStatus: latestRun?.status ?? null,
					latestRunStartedAt: latestRun?.startedAt,
					hasActiveRun: latestRun ? isActiveRunStatus(latestRun.status) : false
				};
			})
		);
	}
});

export const getByThreadId = query({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.id('threadRecords')
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		return await getOwnedThreadRecord(ctx.db, userId, args.threadId);
	}
});

export const remove = mutation({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.id('threadRecords')
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const threadRecord = await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const runs = await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.collect();
		if (runs.some((run) => isActiveRunStatus(run.status))) {
			throw new Error('Cannot delete a thread while a run is active.');
		}
		const messages = await listThreadMessages(ctx, args.threadId);
		for (const message of messages) {
			await ctx.db.delete(message._id);
		}

		for (const run of runs) {
			const jobs = await ctx.db
				.query('executorJobs')
				.withIndex('by_runId_sequence', (query) => query.eq('runId', run._id))
				.collect();
			for (const job of jobs) {
				await ctx.db.delete(job._id);
			}
			await ctx.db.delete(run._id);
		}

		await ctx.db.delete(threadRecord._id);

		const preferences = await ctx.db
			.query('uiPreferences')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.unique();
		if (preferences?.lastThreadId === args.threadId) {
			await ctx.db.patch(preferences._id, {
				lastThreadId: undefined
			});
		}

		return { deleted: true };
	}
});
