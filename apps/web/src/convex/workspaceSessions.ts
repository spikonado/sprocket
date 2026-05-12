import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getWorkspaceSessionByUserAndPath } from '@convex/lib/access';
import { getUserId } from '@convex/lib/auth';
import {
	enforceGuestWorkspaceWriteLimit,
	enforceSignedInWorkspaceWriteLimit
} from '@convex/lib/rateLimits';
import { vWorkspaceOverview } from '@convex/lib/validators';
import {
	getDetachedWorkspaceSessionIdsForClient,
	shouldRefreshWorkspaceHeartbeat,
	withEffectiveWorkspaceSessionState
} from '@convex/lib/workspaceConnection';

export const upsertSelected = mutation({
	args: {
		guestId: v.optional(v.string()),
		workspacePath: v.string(),
		workspaceOverview: vWorkspaceOverview,
		connectedClientId: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		if (userId.startsWith('guest:')) {
			await enforceGuestWorkspaceWriteLimit(ctx, userId);
		} else {
			await enforceSignedInWorkspaceWriteLimit(ctx, userId);
		}
		const now = Date.now();
		const existing = await getWorkspaceSessionByUserAndPath(ctx.db, userId, args.workspacePath);

		const patch = {
			workspacePath: args.workspacePath,
			workspaceName: args.workspaceOverview.name,
			gitBranch: args.workspaceOverview.gitBranch,
			gitDirty: args.workspaceOverview.gitDirty,
			lastHeartbeatAt: args.connectedClientId ? now : undefined,
			connectedClientId: args.connectedClientId,
			nextExecutorSequence: existing?.nextExecutorSequence ?? 0,
			lastSeenAt: now
		};

		if (existing) {
			await ctx.db.patch(existing._id, patch);
			return await ctx.db.get(existing._id);
		}

		const id = await ctx.db.insert('workspaceSessions', {
			userId,
			...patch
		});
		return await ctx.db.get(id);
	}
});

export const listMine = query({
	args: {
		guestId: v.optional(v.string())
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const sessions = await ctx.db
			.query('workspaceSessions')
			.withIndex('by_userId_lastSeenAt', (query) => query.eq('userId', userId))
			.order('desc')
			.collect();
		const now = Date.now();
		return sessions.map((session) => withEffectiveWorkspaceSessionState(session, now));
	}
});

export const heartbeatAttached = mutation({
	args: {
		guestId: v.optional(v.string()),
		clientId: v.string(),
		workspaceSessionIds: v.array(v.id('workspaceSessions'))
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx, args.guestId);
		const now = Date.now();
		const requestedIds = new Set(args.workspaceSessionIds);

		for (const workspaceSessionId of args.workspaceSessionIds) {
			const workspaceSession = await ctx.db.get(workspaceSessionId);
			if (!workspaceSession || workspaceSession.userId !== userId) {
				throw new Error('Workspace session not found.');
			}
		}

		const sessions = await ctx.db
			.query('workspaceSessions')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.collect();
		const detachedSessionIds = getDetachedWorkspaceSessionIdsForClient(
			sessions,
			args.clientId,
			requestedIds
		);
		const detachedSessionIdSet = new Set(detachedSessionIds);

		await Promise.all(
			sessions.map(async (session) => {
				if (requestedIds.has(session._id)) {
					if (shouldRefreshWorkspaceHeartbeat(session, args.clientId, now)) {
						await ctx.db.patch(session._id, {
							connectedClientId: args.clientId,
							lastHeartbeatAt: now
						});
					}
					return;
				}

				if (detachedSessionIdSet.has(session._id)) {
					await ctx.db.patch(session._id, {
						connectedClientId: undefined
					});
				}
			})
		);

		return true;
	}
});
