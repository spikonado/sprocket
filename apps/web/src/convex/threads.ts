import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord, getOwnedWorkspaceSession } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import {
	enforceGuestThreadCreateLimit,
	enforceSignedInThreadCreateLimit
} from '@convex/lib/rateLimits';
import { isRunFinalStatus, vModelId, vReasoningEffort } from '@convex/lib/validators';

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
		await getOwnedWorkspaceSession(ctx.db, userId, args.workspaceSessionId);

		const now = Date.now();
		const recordId = await ctx.db.insert('threadRecords', {
			userId: userId,
			workspaceSessionId: args.workspaceSessionId,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
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
					threadId: record._id,
					threadStatus: 'active',
					workspaceName: workspaceSession?.workspaceName ?? 'Unknown workspace',
					workspacePath: workspaceSession?.workspacePath ?? '',
					latestRunStatus: latestRun?.status ?? null,
					latestRunStartedAt: latestRun?.startedAt,
					hasActiveRun: latestRun ? !isRunFinalStatus(latestRun.status) : false
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
		if (runs.some((run) => !isRunFinalStatus(run.status))) {
			throw new Error('Cannot delete a thread while a run is active.');
		}
		for (const run of runs) {
			for (const messageId of [run.promptMessageId, run.responseMessageId]) {
				if (messageId) {
					await ctx.db.delete(messageId);
				}
			}
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
