import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { vProjectDoc, vProjectWithExecutorStatus } from '@convex/lib/docs';
import {
	getDetachedConnections,
	getEffectiveExecutorStatus,
	shouldRefreshProjectHeartbeat
} from '@convex/lib/projectConnection';
import type { Doc, Id } from '@convex/_generated/dataModel';

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

async function getConnectionForProject(
	ctx: QueryCtx | MutationCtx,
	projectId: Id<'projects'>
): Promise<Doc<'projectConnections'> | null> {
	return await ctx.db
		.query('projectConnections')
		.withIndex('by_projectId', (query) => query.eq('projectId', projectId))
		.unique();
}

async function upsertConnection(
	ctx: MutationCtx,
	args: { projectId: Id<'projects'>; userId: string; clientId: string; now: number }
) {
	const existing = await getConnectionForProject(ctx, args.projectId);
	if (existing) {
		await ctx.db.patch(existing._id, {
			clientId: args.clientId,
			lastHeartbeatAt: args.now
		});
		return;
	}
	await ctx.db.insert('projectConnections', {
		projectId: args.projectId,
		userId: args.userId,
		clientId: args.clientId,
		lastHeartbeatAt: args.now
	});
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
		const project = await findProjectForRepository(ctx, userId, repositoryKey);

		if (project) {
			await ctx.db.patch(project._id, { repositoryKey, displayName, lastSeenAt: now });
			await upsertConnection(ctx, {
				projectId: project._id,
				userId,
				clientId: args.connectedClientId,
				now
			});
			return await ctx.db.get(project._id);
		}

		const id = await ctx.db.insert('projects', {
			userId,
			nextExecutorSequence: 0,
			repositoryKey,
			displayName,
			lastSeenAt: now
		});
		await upsertConnection(ctx, { projectId: id, userId, clientId: args.connectedClientId, now });
		return await ctx.db.get(id);
	}
});

export const listMine = query({
	args: {
		// Older clients omit this and keep receiving a live `executorStatus`
		// (computed from `projectConnections`). Slim callers skip the join so
		// heartbeats don't re-run their subscription.
		slim: v.optional(v.boolean())
	},
	returns: v.array(vProjectWithExecutorStatus),
	handler: async (ctx, args): Promise<Infer<typeof vProjectWithExecutorStatus>[]> => {
		const userId = await getUserId(ctx);
		// Order by creation, newest first: every Convex index implicitly ends
		// with `_creationTime`, so `by_userId` is creation-ordered within a
		// user. Stable across thread activity.
		const projects = await ctx.db
			.query('projects')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.order('desc')
			.collect();
		if (args.slim) {
			return projects;
		}
		const now = Date.now();
		return await Promise.all(
			projects.map(async (project) => ({
				...project,
				executorStatus: getEffectiveExecutorStatus(
					await getConnectionForProject(ctx, project._id),
					now
				)
			}))
		);
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
		const requestedIds = new Set<Id<'projects'>>(args.projectIds);
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

		const connections = await Promise.all(
			projects.map((project) => getConnectionForProject(ctx, project._id))
		);
		const connectionByProjectId = new Map<Id<'projects'>, Doc<'projectConnections'>>();
		for (const connection of connections) {
			if (connection) {
				connectionByProjectId.set(connection.projectId, connection);
			}
		}

		const detachedConnections = getDetachedConnections(
			[...connectionByProjectId.values()],
			args.clientId,
			requestedIds
		);

		await Promise.all([
			...[...requestedIds].map(async (projectId) => {
				const connection = connectionByProjectId.get(projectId);
				if (shouldRefreshProjectHeartbeat(connection, args.clientId, now)) {
					await upsertConnection(ctx, { projectId, userId, clientId: args.clientId, now });
				}
			}),
			...detachedConnections.map((connection) => ctx.db.delete(connection._id))
		]);

		return true;
	}
});
