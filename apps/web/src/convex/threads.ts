import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord, getOwnedWorkspaceSession } from '@convex/lib/access';
import { resolveActor } from '@convex/lib/auth';
import {
	enforceGuestThreadCreateLimit,
	enforceSignedInThreadCreateLimit
} from '@convex/lib/rateLimits';
import { isActiveRunStatus } from '@convex/lib/runs';
import { listThreadMessages } from '@convex/lib/threadMessages';
import { vModelId, vReasoningEffort } from '@convex/lib/validators';

function makeThreadTitle(workspaceName: string) {
	return `${workspaceName} Thread`;
}

export const create = mutation({
	args: {
		guestId: v.optional(v.string()),
		workspaceSessionId: v.id('workspaceSessions'),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort
	},
	handler: async (ctx, args) => {
		const actor = await resolveActor(ctx, args.guestId);
		if (actor.guestId) {
			await enforceGuestThreadCreateLimit(ctx, actor.guestId);
		} else {
			await enforceSignedInThreadCreateLimit(ctx, actor.ownerId);
		}
		const workspaceSession = await getOwnedWorkspaceSession(
			ctx.db,
			actor.ownerId,
			args.workspaceSessionId
		);

		const title = makeThreadTitle(workspaceSession.workspaceName);
		const threadId = crypto.randomUUID();
		const now = Date.now();
		const recordId = await ctx.db.insert('threadRecords', {
			userId: actor.ownerId,
			guestId: actor.guestId,
			threadId,
			workspaceSessionId: args.workspaceSessionId,
			workspacePath: workspaceSession.workspacePath,
			workspaceName: workspaceSession.workspaceName,
			title,
			summary: workspaceSession.workspacePath,
			selectedModel: args.selectedModel,
			reasoningEffort: args.reasoningEffort,
			nextMessageOrder: 0,
			lastMessageAt: now
		});

		return {
			threadId,
			recordId
		};
	}
});

export const listMine = query({
	args: {
		guestId: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const actor = await resolveActor(ctx, args.guestId);
		const records = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_lastMessageAt', (query) => query.eq('userId', actor.ownerId))
			.order('desc')
			.collect();
		return await Promise.all(
			records.map(async (record) => {
				const latestRun = await ctx.db
					.query('runs')
					.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', record.threadId))
					.order('desc')
					.first();
				return {
					...record,
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
		threadId: v.string()
	},
	handler: async (ctx, args) => {
		const actor = await resolveActor(ctx, args.guestId);
		return await getOwnedThreadRecord(ctx.db, actor.ownerId, args.threadId);
	}
});

export const remove = mutation({
	args: {
		guestId: v.optional(v.string()),
		threadId: v.string()
	},
	handler: async (ctx, args) => {
		const actor = await resolveActor(ctx, args.guestId);
		const threadRecord = await getOwnedThreadRecord(ctx.db, actor.ownerId, args.threadId);

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
			.withIndex('by_userId', (query) => query.eq('userId', actor.ownerId))
			.unique();
		if (preferences?.lastThreadId === args.threadId) {
			await ctx.db.patch(preferences._id, {
				lastThreadId: undefined
			});
		}

		return { deleted: true };
	}
});
