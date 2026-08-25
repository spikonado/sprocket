import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { vProjectListItem } from '@convex/lib/docs';
import {
	getDetachedConnections,
	getEffectiveExecutorStatus,
	legacyConnectionFromProject,
	shouldRefreshProjectHeartbeat
} from '@convex/lib/projectConnection';
import type { Doc, Id } from '@convex/_generated/dataModel';
import schema from '@convex/schema';

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
		await ctx.db.patch('projectConnections', existing._id, {
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

async function getConnectionsForUser(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Map<Id<'projects'>, Doc<'projectConnections'>>> {
	const connections = await ctx.db
		.query('projectConnections')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.collect();
	return new Map(connections.map((connection) => [connection.projectId, connection]));
}

export const upsertSelected = mutation({
	args: {
		repositoryKey: v.string(),
		displayName: v.string(),
		connectedClientId: v.string()
	},
	returns: v.union(schema.doc('projects'), v.null()),
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
			await ctx.db.patch('projects', project._id, { repositoryKey, displayName, lastSeenAt: now });
			await upsertConnection(ctx, {
				projectId: project._id,
				userId,
				clientId: args.connectedClientId,
				now
			});
			return await ctx.db.get('projects', project._id);
		}

		const id = await ctx.db.insert('projects', {
			userId,
			nextExecutorSequence: 0,
			repositoryKey,
			displayName,
			lastSeenAt: now
		});
		await upsertConnection(ctx, { projectId: id, userId, clientId: args.connectedClientId, now });
		return await ctx.db.get('projects', id);
	}
});

export const listMine = query({
	args: {
		// Older released clients omit this and keep receiving a live
		// `executorStatus`. Callers passing `false` skip the `projectConnections`
		// read entirely, so heartbeats never re-run their subscription. Once old
		// clients age out, drop the arg and the `executorStatus` field.
		includeExecutorStatus: v.optional(v.boolean()),
		// Required to compute `executorStatus` without reading the clock in the
		// query. Omitted `now` skips status so the subscription stays reactive.
		now: v.optional(v.number())
	},
	returns: v.array(vProjectListItem),
	handler: async (ctx, args): Promise<Infer<typeof vProjectListItem>[]> => {
		const userId = await getUserId(ctx);
		// Order by creation, newest first: every Convex index implicitly ends
		// with `_creationTime`, so `by_userId` is creation-ordered within a
		// user. Stable across thread activity.
		const projects = await ctx.db
			.query('projects')
			.withIndex('by_userId', (query) => query.eq('userId', userId))
			.order('desc')
			.collect();
		const now = args.now;
		if (args.includeExecutorStatus === false || now === undefined) {
			return projects;
		}
		const connectionByProjectId = await getConnectionsForUser(ctx, userId);
		return projects.map((project) => ({
			...project,
			executorStatus: getEffectiveExecutorStatus(
				connectionByProjectId.get(project._id) ?? legacyConnectionFromProject(project),
				now
			)
		}));
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
		// The requested set is small (the attached projects), so validate
		// ownership per id instead of scanning every project the user has.
		await Promise.all(
			[...requestedIds].map(async (projectId) => {
				const project = await ctx.db.get('projects', projectId);
				if (!project || project.userId !== userId) {
					throw new Error('Project not found.');
				}
			})
		);

		const connectionByProjectId = await getConnectionsForUser(ctx, userId);
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
			...detachedConnections.map((connection) =>
				ctx.db.delete('projectConnections', connection._id)
			)
		]);

		return true;
	}
});
