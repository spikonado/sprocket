import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	internalMutation,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import {
	MAX_FILE_NAME_LENGTH,
	vArtifactScope,
	vArtifactType,
	vListArtifactsResult,
	type ArtifactScope
} from '@convex/lib/validators';
import schema from '@convex/schema';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { RUN_NO_LONGER_ACTIVE, toAgentToolConvexError } from '@convex/lib/agentErrors';

const MAX_TITLE_LENGTH = MAX_FILE_NAME_LENGTH;
const MAX_ARTIFACT_PATH_BYTES = 4096;
const MAX_ARTIFACT_CONTENT_BYTES = 500_000;

const vArtifactMutationResult = v.object({
	artifactId: v.id('artifacts'),
	revision: v.number(),
	title: v.string(),
	contentType: vArtifactType,
	localPath: v.string(),
	scope: vArtifactScope
});

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function requireRepositoryKey(thread: Doc<'threadRecords'>): string {
	const repositoryKey = thread.repositoryKey?.trim();
	if (!repositoryKey) {
		throw new Error('Repository key is required.');
	}
	return repositoryKey;
}

function validateRepositoryKey(repositoryKey: string): string {
	const trimmed = repositoryKey.trim();
	if (!trimmed) {
		throw new Error('Repository key is required.');
	}
	return trimmed;
}

function validateArtifactTitle(title: string): string {
	const trimmed = title.trim();
	if (!trimmed) {
		throw new Error('Artifact title cannot be empty.');
	}
	if (trimmed.length > MAX_TITLE_LENGTH) {
		throw new Error(`Artifact title cannot exceed ${MAX_TITLE_LENGTH} characters.`);
	}
	return trimmed;
}

function validateArtifactContent(content: string) {
	if (utf8ByteLength(content) > MAX_ARTIFACT_CONTENT_BYTES) {
		throw new Error(`Artifact content cannot exceed ${MAX_ARTIFACT_CONTENT_BYTES} bytes.`);
	}
}

function validateArtifactLocalPath(localPath: string): string {
	if (!localPath) {
		throw new Error('Artifact path cannot be empty.');
	}
	if (utf8ByteLength(localPath) > MAX_ARTIFACT_PATH_BYTES) {
		throw new Error(`Artifact path cannot exceed ${MAX_ARTIFACT_PATH_BYTES} bytes.`);
	}
	if (localPath.includes('\0')) {
		throw new Error('Artifact path is invalid.');
	}
	return localPath;
}

async function requireActiveRun(
	ctx: QueryCtx | MutationCtx,
	runId: Id<'runs'>,
	claimId: string,
	executionSecret: string
): Promise<Doc<'runs'>> {
	const run = await getExecutionRun(ctx, runId, executionSecret);
	if (!ownsActiveRunClaim(run, claimId, Date.now())) {
		throw new Error(RUN_NO_LONGER_ACTIVE);
	}
	return run;
}

async function registryState(ctx: QueryCtx, userId: string, repositoryKey: string) {
	return await ctx.db
		.query('artifactRegistries')
		.withIndex('by_userId_and_repositoryKey', (q) =>
			q.eq('userId', userId).eq('repositoryKey', repositoryKey)
		)
		.unique();
}

async function bumpRegistry(ctx: MutationCtx, userId: string, repositoryKey: string) {
	const state = await registryState(ctx, userId, repositoryKey);
	if (state) await ctx.db.patch('artifactRegistries', state._id, { revision: state.revision + 1 });
	else await ctx.db.insert('artifactRegistries', { userId, repositoryKey, revision: 1 });
}

function mutationResult(artifact: Doc<'artifacts'>) {
	return {
		artifactId: artifact._id,
		revision: artifact.revision,
		title: artifact.title,
		contentType: artifact.type,
		localPath: artifact.localPath,
		scope: artifact.scope
	};
}

async function loadThreadForRun(ctx: QueryCtx | MutationCtx, run: Doc<'runs'>): Promise<string> {
	const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);
	return requireRepositoryKey(thread);
}

async function findArtifactByPath(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: string;
		repositoryKey: string;
		scope: ArtifactScope;
		threadId: Id<'threadRecords'> | undefined;
		localPath: string;
	}
): Promise<Doc<'artifacts'> | null> {
	if (args.scope === 'thread') {
		const threadId = args.threadId;
		if (!threadId) {
			throw new Error('Thread is required for thread-scoped artifacts.');
		}
		const found = await ctx.db
			.query('artifacts')
			.withIndex('by_userId_and_threadId_and_localPath', (q) =>
				q.eq('userId', args.userId).eq('threadId', threadId).eq('localPath', args.localPath)
			)
			.first();
		return found?.scope === 'thread' ? found : null;
	}
	return await ctx.db
		.query('artifacts')
		.withIndex('by_userId_and_repositoryKey_and_scope_and_localPath', (q) =>
			q
				.eq('userId', args.userId)
				.eq('repositoryKey', args.repositoryKey)
				.eq('scope', 'project')
				.eq('localPath', args.localPath)
		)
		.first();
}

async function listVisibleArtifacts(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	repositoryKey: string,
	threadId: Id<'threadRecords'> | undefined,
	cursor: string | null
) {
	const result = await ctx.db
		.query('artifacts')
		.withIndex('by_userId_and_repositoryKey_and_scope_and_localPath', (q) =>
			q.eq('userId', userId).eq('repositoryKey', repositoryKey)
		)
		.paginate({ cursor, numItems: 8, maximumRowsRead: 8, maximumBytesRead: 1_000_000 });
	return {
		page: result.page.filter((artifact) =>
			canAccessArtifact(artifact, userId, repositoryKey, threadId)
		),
		isDone: result.isDone,
		continueCursor: result.continueCursor,
		revision: (await registryState(ctx, userId, repositoryKey))?.revision ?? 0
	};
}

const pageFields = { isDone: v.boolean(), continueCursor: v.string(), revision: v.number() };

async function authorizeScope(
	ctx: QueryCtx,
	repositoryKey: string,
	threadId?: Id<'threadRecords'>
) {
	const userId = await getUserId(ctx);
	if (threadId !== undefined) {
		const thread = await getOwnedThreadRecord(ctx.db, userId, threadId);
		if (requireRepositoryKey(thread) !== repositoryKey) throw new Error('Thread not found.');
	}
	return userId;
}

function canAccessArtifact(
	artifact: Doc<'artifacts'>,
	userId: string,
	repositoryKey: string,
	threadId: Id<'threadRecords'> | undefined
): boolean {
	if (artifact.userId !== userId || artifact.repositoryKey !== repositoryKey) {
		return false;
	}
	if (artifact.scope === 'project') {
		return true;
	}
	return artifact.scope === 'thread' && threadId !== undefined && artifact.threadId === threadId;
}

async function requireAccessibleArtifact(
	ctx: QueryCtx | MutationCtx,
	artifactId: Id<'artifacts'>,
	userId: string,
	repositoryKey: string,
	threadId: Id<'threadRecords'> | undefined
): Promise<Doc<'artifacts'>> {
	const artifact = await ctx.db.get('artifacts', artifactId);
	if (!artifact || !canAccessArtifact(artifact, userId, repositoryKey, threadId)) {
		throw new Error('Artifact not found.');
	}
	return artifact;
}

async function writeArtifactFields(
	ctx: MutationCtx,
	artifact: Doc<'artifacts'>,
	fields: {
		localPath: string;
		content: string;
		title: string;
		contentType: Doc<'artifacts'>['type'];
	}
): Promise<Doc<'artifacts'>> {
	const unchanged =
		artifact.localPath === fields.localPath &&
		artifact.content === fields.content &&
		artifact.title === fields.title &&
		artifact.type === fields.contentType;
	if (unchanged) {
		return artifact;
	}
	const now = Date.now();
	const revision = artifact.revision + 1;
	await ctx.db.patch('artifacts', artifact._id, {
		localPath: fields.localPath,
		content: fields.content,
		title: fields.title,
		type: fields.contentType,
		revision,
		updatedAt: now
	});
	await bumpRegistry(ctx, artifact.userId, artifact.repositoryKey);
	return {
		...artifact,
		localPath: fields.localPath,
		content: fields.content,
		title: fields.title,
		type: fields.contentType,
		revision,
		updatedAt: now
	};
}

export async function rekeyOwnedArtifacts(
	ctx: MutationCtx,
	userId: string,
	from: string,
	to: string
): Promise<void> {
	if (from === to) return;
	await bumpRegistry(ctx, userId, from);
	const source = await registryState(ctx, userId, from);
	if (!source) throw new Error('Artifact registry not found.');
	await ctx.db.patch('artifactRegistries', source._id, { rekeyTo: to });
	const destination = await registryState(ctx, userId, to);
	if (destination?.rekeyTo)
		await ctx.db.patch('artifactRegistries', destination._id, { rekeyTo: undefined });
	await rekeyArtifactBatch(ctx, userId, from, to);
}

async function rekeyArtifactBatch(
	ctx: MutationCtx,
	userId: string,
	from: string,
	to: string
): Promise<void> {
	if ((await registryState(ctx, userId, from))?.rekeyTo !== to) return;
	let destination = to;
	const visited = new Set([from]);
	for (;;) {
		if (visited.has(destination)) throw new Error('Artifact repository rename cycle.');
		visited.add(destination);
		const redirected = (await registryState(ctx, userId, destination))?.rekeyTo;
		if (!redirected) break;
		destination = redirected;
	}
	const artifacts = await ctx.db
		.query('artifacts')
		.withIndex('by_userId_and_repositoryKey_and_scope_and_localPath', (q) =>
			q.eq('userId', userId).eq('repositoryKey', from)
		)
		.take(8);
	for (const artifact of artifacts) {
		await ctx.db.patch('artifacts', artifact._id, { repositoryKey: destination });
	}
	if (artifacts.length > 0) {
		await bumpRegistry(ctx, userId, from);
		await bumpRegistry(ctx, userId, destination);
	}
	if (artifacts.length === 8) {
		await ctx.scheduler.runAfter(0, internal.artifacts.continueRekey, { userId, from, to });
	}
}

export const continueRekey = internalMutation({
	args: { userId: v.string(), from: v.string(), to: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await rekeyArtifactBatch(ctx, args.userId, args.from, args.to);
	}
});

export const addArtifact = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		scope: vArtifactScope,
		localPath: v.string(),
		content: v.string(),
		title: v.string(),
		contentType: vArtifactType
	},
	returns: vArtifactMutationResult,
	handler: async (ctx, args) => {
		try {
			const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
			const repositoryKey = await loadThreadForRun(ctx, run);
			const localPath = validateArtifactLocalPath(args.localPath);
			const title = validateArtifactTitle(args.title);
			validateArtifactContent(args.content);
			const threadId = args.scope === 'thread' ? run.threadId : undefined;

			const existing = await findArtifactByPath(ctx, {
				userId: run.userId,
				repositoryKey,
				scope: args.scope,
				threadId,
				localPath
			});
			if (existing) {
				if (!canAccessArtifact(existing, run.userId, repositoryKey, run.threadId)) {
					throw new Error('Artifact not found.');
				}
				return mutationResult(
					await writeArtifactFields(ctx, existing, {
						localPath,
						content: args.content,
						title,
						contentType: args.contentType
					})
				);
			}

			const now = Date.now();
			const record: Omit<Doc<'artifacts'>, '_id' | '_creationTime'> = {
				userId: run.userId,
				scope: args.scope,
				repositoryKey,
				localPath,
				content: args.content,
				type: args.contentType,
				title,
				revision: 1,
				createdAt: now,
				updatedAt: now
			};
			if (threadId) record.threadId = threadId;
			const artifactId = await ctx.db.insert('artifacts', record);
			await bumpRegistry(ctx, run.userId, repositoryKey);
			const created = await ctx.db.get('artifacts', artifactId);
			if (!created) {
				throw new Error('Failed to create the artifact.');
			}
			return mutationResult(created);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const editArtifact = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		artifactId: v.id('artifacts'),
		localPath: v.string(),
		content: v.string(),
		title: v.string(),
		contentType: vArtifactType
	},
	returns: vArtifactMutationResult,
	handler: async (ctx, args) => {
		try {
			const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
			const repositoryKey = await loadThreadForRun(ctx, run);
			const localPath = validateArtifactLocalPath(args.localPath);
			const title = validateArtifactTitle(args.title);
			validateArtifactContent(args.content);

			const artifact = await requireAccessibleArtifact(
				ctx,
				args.artifactId,
				run.userId,
				repositoryKey,
				run.threadId
			);

			const occupant = await findArtifactByPath(ctx, {
				userId: run.userId,
				repositoryKey,
				scope: artifact.scope,
				threadId: artifact.threadId,
				localPath
			});
			if (occupant && occupant._id !== artifact._id) {
				throw new Error('Artifact path is already in use.');
			}

			return mutationResult(
				await writeArtifactFields(ctx, artifact, {
					localPath,
					content: args.content,
					title,
					contentType: args.contentType
				})
			);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const listArtifactsForRun = query({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	returns: v.object({ ...pageFields, page: vListArtifactsResult.fields.artifacts }),
	handler: async (ctx, args) => {
		try {
			const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
			const repositoryKey = await loadThreadForRun(ctx, run);
			const result = await listVisibleArtifacts(
				ctx,
				run.userId,
				repositoryKey,
				run.threadId,
				args.cursor ?? null
			);
			return {
				...result,
				page: result.page.map(({ _id, _creationTime, content, userId, ...metadata }) => {
					void _creationTime;
					void content;
					void userId;
					return { artifactId: _id, ...metadata };
				})
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const listArtifacts = query({
	args: {
		threadId: v.optional(v.id('threadRecords')),
		repositoryKey: v.string(),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	returns: v.object({ ...pageFields, page: v.array(schema.doc('artifacts')) }),
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await authorizeScope(ctx, repositoryKey, args.threadId);
		return await listVisibleArtifacts(
			ctx,
			userId,
			repositoryKey,
			args.threadId,
			args.cursor ?? null
		);
	}
});

export const getArtifactState = query({
	args: { repositoryKey: v.string(), threadId: v.optional(v.id('threadRecords')) },
	returns: v.number(),
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await authorizeScope(ctx, repositoryKey, args.threadId);
		return (await registryState(ctx, userId, repositoryKey))?.revision ?? 0;
	}
});

export const syncArtifact = mutation({
	args: {
		artifactId: v.id('artifacts'),
		repositoryKey: v.string(),
		threadId: v.optional(v.id('threadRecords')),
		expectedRevision: v.number(),
		localPath: v.string(),
		content: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const localPath = validateArtifactLocalPath(args.localPath);
		validateArtifactContent(args.content);

		if (args.threadId !== undefined) {
			const thread = await getOwnedThreadRecord(ctx.db, userId, args.threadId);
			if (requireRepositoryKey(thread) !== repositoryKey) {
				throw new Error('Thread not found.');
			}
		}

		const artifact = await requireAccessibleArtifact(
			ctx,
			args.artifactId,
			userId,
			repositoryKey,
			args.threadId
		);
		if (artifact.localPath !== localPath || artifact.revision !== args.expectedRevision) {
			return false;
		}
		await writeArtifactFields(ctx, artifact, {
			localPath,
			content: args.content,
			title: artifact.title,
			contentType: artifact.type
		});
		return true;
	}
});
