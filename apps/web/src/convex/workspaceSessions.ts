import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getWorkspaceSessionByUserAndPath } from '@convex/lib/access';
import { resolveActor } from '@convex/lib/auth';
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
		const actor = await resolveActor(ctx, args.guestId);
		if (actor.guestId) {
			await enforceGuestWorkspaceWriteLimit(ctx, actor.guestId);
		} else {
			await enforceSignedInWorkspaceWriteLimit(ctx, actor.ownerId);
		}
		const now = Date.now();
		const existing = await getWorkspaceSessionByUserAndPath(
			ctx.db,
			actor.ownerId,
			args.workspacePath
		);

		const patch = {
			guestId: actor.guestId,
			subject: actor.identity?.subject,
			email: actor.identity?.email,
			name: actor.identity?.name,
			workspacePath: args.workspacePath,
			workspaceName: args.workspaceOverview.name,
			workspaceOverview: args.workspaceOverview,
			gitBranch: args.workspaceOverview.gitBranch,
			gitDirty: args.workspaceOverview.gitDirty,
			executorStatus: args.connectedClientId ? ('connected' as const) : ('disconnected' as const),
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
			userId: actor.ownerId,
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
		const actor = await resolveActor(ctx, args.guestId);
		const sessions = await ctx.db
			.query('workspaceSessions')
			.withIndex('by_userId_lastSeenAt', (query) => query.eq('userId', actor.ownerId))
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
		const actor = await resolveActor(ctx, args.guestId);
		const now = Date.now();
		const requestedIds = new Set(args.workspaceSessionIds);

		for (const workspaceSessionId of args.workspaceSessionIds) {
			const workspaceSession = await ctx.db.get(workspaceSessionId);
			if (!workspaceSession || workspaceSession.userId !== actor.ownerId) {
				throw new Error('Workspace session not found.');
			}
		}

		const sessions = await ctx.db
			.query('workspaceSessions')
			.withIndex('by_userId', (query) => query.eq('userId', actor.ownerId))
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
							executorStatus: 'connected',
							connectedClientId: args.clientId,
							lastHeartbeatAt: now
						});
					}
					return;
				}

				if (detachedSessionIdSet.has(session._id)) {
					await ctx.db.patch(session._id, {
						executorStatus: 'disconnected',
						connectedClientId: undefined
					});
				}
			})
		);

		return true;
	}
});
