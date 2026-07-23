import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import {
	getDetachedWorkspaceSessionIdsForClient,
	shouldRefreshWorkspaceHeartbeat,
	withEffectiveWorkspaceSessionState
} from '@convex/lib/workspaceConnection';
import type { Doc } from '@convex/_generated/dataModel';

export const upsertSelected = mutation({
	args: {
		workspaceName: v.string(),
		connectedClientId: v.string()
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx);
		const workspaceSession: Doc<'workspaceSessions'> | null = await ctx.db
			.query('workspaceSessions')
			.withIndex('by_user_workspaceName', (query) =>
				query.eq('userId', userId).eq('workspaceName', args.workspaceName)
			)
			.unique();

		const now = Date.now();
		const patch = {
			workspaceName: args.workspaceName,
			lastHeartbeatAt: now,
			connectedClientId: args.connectedClientId,
			lastSeenAt: now
		};

		if (workspaceSession) {
			await ctx.db.patch(workspaceSession._id, patch);
			return await ctx.db.get(workspaceSession._id);
		}

		const id = await ctx.db.insert('workspaceSessions', {
			userId,
			nextExecutorSequence: 0,
			...patch
		});
		return await ctx.db.get(id);
	}
});

export const listMine = query({
	args: {},
	handler: async (ctx) => {
		const userId: string = await getUserId(ctx);
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
		clientId: v.string(),
		workspaceSessionIds: v.array(v.id('workspaceSessions'))
	},
	handler: async (ctx, args) => {
		const userId: string = await getUserId(ctx);
		const now = Date.now();
		const requestedIds = new Set(args.workspaceSessionIds);
		const sessions = await ctx.db
			.query('workspaceSessions')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.collect();
		const ownedSessionIds = new Set(sessions.map((session) => session._id));
		for (const workspaceSessionId of requestedIds) {
			if (!ownedSessionIds.has(workspaceSessionId)) {
				throw new Error('Workspace session not found.');
			}
		}
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
