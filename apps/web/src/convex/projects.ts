import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { vProjectDoc, vProjectWithExecutorStatus } from '@convex/lib/docs';
import {
	getDetachedProjectIdsForClient,
	shouldRefreshProjectHeartbeat,
	withEffectiveProjectState
} from '@convex/lib/projectConnection';
import type { Doc } from '@convex/_generated/dataModel';

async function findProjectForRepository(
	ctx: MutationCtx,
	userId: string,
	repositoryKey: string
): Promise<Doc<'projects'> | null> {
	return await ctx.db
		.query('projects')
		.withIndex('by_user_repositoryKey', (query) =>
			query.eq('userId', userId).eq('repositoryKey', repositoryKey)
		)
		.unique();
}

export const upsertSelected = mutation({
	args: {
		repositoryKey: v.string(),
		displayName: v.string(),
		connectedClientId: v.string()
	},
	returns: v.union(vProjectDoc, v.null()),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const repositoryKey = args.repositoryKey.trim();
		const displayName = args.displayName.trim();
		if (repositoryKey.length === 0) {
			throw new Error('Repository key is required.');
		}
		if (displayName.length === 0) {
			throw new Error('Display name is required.');
		}

		const now = Date.now();
		const patch = {
			repositoryKey,
			displayName,
			lastHeartbeatAt: now,
			connectedClientId: args.connectedClientId,
			lastSeenAt: now
		};

		const project = await findProjectForRepository(ctx, userId, repositoryKey);

		if (project) {
			await ctx.db.patch(project._id, patch);
			return await ctx.db.get(project._id);
		}

		const id = await ctx.db.insert('projects', {
			userId,
			nextExecutorSequence: 0,
			...patch
		});
		return await ctx.db.get(id);
	}
});

export const listMine = query({
	args: {},
	returns: v.array(vProjectWithExecutorStatus),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const projects = await ctx.db
			.query('projects')
			.withIndex('by_userId_lastSeenAt', (query) => query.eq('userId', userId))
			.order('desc')
			.collect();
		const now = Date.now();
		return projects.map((project) => withEffectiveProjectState(project, now));
	}
});

export const heartbeatAttached = mutation({
	args: {
		clientId: v.string(),
		projectIds: v.array(v.id('projects'))
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const now = Date.now();
		const requestedIds = new Set(args.projectIds);
		const projects = await ctx.db
			.query('projects')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.collect();
		const ownedProjectIds = new Set(projects.map((project) => project._id));
		for (const projectId of requestedIds) {
			if (!ownedProjectIds.has(projectId)) {
				throw new Error('Project not found.');
			}
		}
		const detachedProjectIds = getDetachedProjectIdsForClient(
			projects,
			args.clientId,
			requestedIds
		);
		const detachedProjectIdSet = new Set(detachedProjectIds);

		await Promise.all(
			projects.map(async (project) => {
				if (requestedIds.has(project._id)) {
					if (shouldRefreshProjectHeartbeat(project, args.clientId, now)) {
						await ctx.db.patch(project._id, {
							connectedClientId: args.clientId,
							lastHeartbeatAt: now
						});
					}
					return;
				}

				if (detachedProjectIdSet.has(project._id)) {
					await ctx.db.patch(project._id, {
						connectedClientId: undefined
					});
				}
			})
		);

		return true;
	}
});
