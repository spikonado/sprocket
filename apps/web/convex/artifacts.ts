import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	internalMutation,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import {
	MAX_FILE_NAME_LENGTH,
	vArtifactScope,
	vArtifactType,
	vListArtifactsResult
} from '@convex/lib/validators';
import schema from '@convex/schema';
import { registryState, bumpRegistry } from '@convex/lib/artifactRegistry';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { RUN_NO_LONGER_ACTIVE, toAgentToolConvexError } from '@convex/lib/agentErrors';

const MAX_TITLE_LENGTH = MAX_FILE_NAME_LENGTH;

const MAX_ARTIFACT_CONTENT_BYTES = 500_000;

const vArtifactMutationResult = v.object({
	artifactId: v.id('artifacts'),
	revision: v.number(),
	title: v.string(),
	contentType: vArtifactType,
	scope: v.literal('project')
});

const vDeleteArtifactMutationResult = v.object({
	artifactId: v.id('artifacts')
});

const vProjectArtifact = schema
	.doc('artifacts')
	.omit('threadId')
	.extend({
		scope: v.literal('project')
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

function mutationResult(artifact: Doc<'artifacts'>) {
	return {
		artifactId: artifact._id,
		revision: artifact.revision,
		title: artifact.title,
		contentType: artifact.type,
		scope: 'project' as const
	};
}

async function loadThreadForRun(ctx: QueryCtx | MutationCtx, run: Doc<'runs'>): Promise<string> {
	const thread = await getOwnedThreadRecord(ctx.db, run.userId, run.threadId);

	return requireRepositoryKey(thread);
}

async function listVisibleArtifacts(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	repositoryKey: string,
	cursor: string | null
) {
	const result = await ctx.db
		.query('artifacts')
		.withIndex('by_userId_and_repositoryKey_and_scope', (q) =>
			q.eq('userId', userId).eq('repositoryKey', repositoryKey)
		)
		.paginate({ cursor, numItems: 8, maximumRowsRead: 8, maximumBytesRead: 1_000_000 });

	return {
		page: result.page.map(projectArtifact),
		isDone: result.isDone,
		continueCursor: result.continueCursor,
		revision: (await registryState(ctx, userId, repositoryKey))?.revision ?? 0
	};
}

const pageFields = { isDone: v.boolean(), continueCursor: v.string(), revision: v.number() };

async function authorizeProject(
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

function projectArtifact(artifact: Doc<'artifacts'>) {
	const { threadId, ...project } = artifact;
	void threadId;

	return { ...project, scope: 'project' as const };
}

function canAccessArtifact(
	artifact: Doc<'artifacts'>,
	userId: string,
	repositoryKey: string
): boolean {
	return artifact.userId === userId && artifact.repositoryKey === repositoryKey;
}

async function promoteArtifact(ctx: MutationCtx, artifact: Doc<'artifacts'>) {
	if (artifact.scope === 'project' && artifact.threadId === undefined) return artifact;

	await ctx.db.patch('artifacts', artifact._id, { scope: 'project', threadId: undefined });
	await bumpRegistry(ctx, artifact.userId, artifact.repositoryKey);

	return projectArtifact(artifact);
}

async function findAccessibleArtifact(
	ctx: QueryCtx | MutationCtx,
	artifactId: Id<'artifacts'>,
	userId: string,
	repositoryKey: string
): Promise<Doc<'artifacts'> | null> {
	const artifact = await ctx.db.get('artifacts', artifactId);

	if (artifact && !canAccessArtifact(artifact, userId, repositoryKey)) {
		throw new Error('Artifact not found.');
	}

	return artifact;
}

async function requireAccessibleArtifact(
	ctx: QueryCtx | MutationCtx,
	artifactId: Id<'artifacts'>,
	userId: string,
	repositoryKey: string
): Promise<Doc<'artifacts'>> {
	const artifact = await findAccessibleArtifact(ctx, artifactId, userId, repositoryKey);

	if (!artifact) throw new Error('Artifact not found.');

	return artifact;
}

async function deleteAccessibleArtifact(
	ctx: MutationCtx,
	artifactId: Id<'artifacts'>,
	userId: string,
	repositoryKey: string
) {
	const artifact = await findAccessibleArtifact(ctx, artifactId, userId, repositoryKey);

	if (artifact) {
		await ctx.db.delete('artifacts', artifactId);
		await bumpRegistry(ctx, userId, repositoryKey);
	}

	return { artifactId };
}

async function writeArtifactFields(
	ctx: MutationCtx,
	artifact: Doc<'artifacts'>,
	fields: {
		content: string;
		title: string;
		contentType: Doc<'artifacts'>['type'];
	}
): Promise<Doc<'artifacts'>> {
	const unchanged =
		artifact.content === fields.content &&
		artifact.title === fields.title &&
		artifact.type === fields.contentType;

	if (unchanged) return await promoteArtifact(ctx, artifact);

	const now = Date.now();
	const revision = artifact.revision + 1;
	await ctx.db.patch('artifacts', artifact._id, {
		scope: 'project',
		threadId: undefined,
		content: fields.content,
		title: fields.title,
		type: fields.contentType,
		revision,
		updatedAt: now
	});
	await bumpRegistry(ctx, artifact.userId, artifact.repositoryKey);

	return {
		...projectArtifact(artifact),
		content: fields.content,
		title: fields.title,
		type: fields.contentType,
		revision,
		updatedAt: now
	};
}

export const continueRekey = internalMutation({
	args: { userId: v.string(), from: v.string(), to: v.string() },
	returns: v.null(),
	handler: () => null
});

export const addArtifact = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		// Released agents may still request thread scope; all writes are project-wide.
		scope: v.optional(vArtifactScope),
		registrationId: v.string(),
		content: v.string(),
		title: v.string(),
		contentType: vArtifactType
	},
	returns: vArtifactMutationResult,
	handler: async (ctx, args) => {
		try {
			const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
			const repositoryKey = await loadThreadForRun(ctx, run);

			if (!args.registrationId || args.registrationId.length > 128)
				throw new Error('Invalid registration ID.');
			const title = validateArtifactTitle(args.title);
			validateArtifactContent(args.content);

			const existing = await ctx.db
				.query('artifacts')
				.withIndex('by_userId_and_registrationId', (q) =>
					q.eq('userId', run.userId).eq('registrationId', args.registrationId)
				)
				.unique();

			if (existing) {
				if (!canAccessArtifact(existing, run.userId, repositoryKey)) {
					throw new Error('Artifact not found.');
				}

				return mutationResult(await promoteArtifact(ctx, existing));
			}

			const now = Date.now();

			const record: Omit<Doc<'artifacts'>, '_id' | '_creationTime'> = {
				userId: run.userId,
				scope: 'project',
				repositoryKey,
				registrationId: args.registrationId,
				content: args.content,
				type: args.contentType,
				title,
				revision: 1,
				createdAt: now,
				updatedAt: now
			};

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
		expectedRevision: v.number(),
		content: v.string(),
		title: v.string(),
		contentType: vArtifactType
	},
	returns: vArtifactMutationResult,
	handler: async (ctx, args) => {
		try {
			const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
			const repositoryKey = await loadThreadForRun(ctx, run);
			const title = validateArtifactTitle(args.title);
			validateArtifactContent(args.content);

			const artifact = await requireAccessibleArtifact(
				ctx,
				args.artifactId,
				run.userId,
				repositoryKey
			);

			if (artifact.revision !== args.expectedRevision)
				throw new Error('Artifact changed; reload it before editing.');

			return mutationResult(
				await writeArtifactFields(ctx, artifact, {
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

export const deleteArtifact = mutation({
	args: { artifactId: v.id('artifacts'), repositoryKey: v.string() },
	returns: vDeleteArtifactMutationResult,
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await authorizeProject(ctx, repositoryKey);

		return await deleteAccessibleArtifact(ctx, args.artifactId, userId, repositoryKey);
	}
});

export const deleteArtifactForRun = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		artifactId: v.id('artifacts')
	},
	returns: vDeleteArtifactMutationResult,
	handler: async (ctx, args) => {
		try {
			const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
			const repositoryKey = await loadThreadForRun(ctx, run);

			return await deleteAccessibleArtifact(ctx, args.artifactId, run.userId, repositoryKey);
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
	returns: v.object({
		...pageFields,
		page: v.array(
			vListArtifactsResult.fields.artifacts.element.omit('threadId').extend({
				scope: v.literal('project')
			})
		)
	}),
	handler: async (ctx, args) => {
		try {
			const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
			const repositoryKey = await loadThreadForRun(ctx, run);

			const result = await listVisibleArtifacts(
				ctx,
				run.userId,
				repositoryKey,
				args.cursor ?? null
			);

			return {
				...result,
				page: result.page.map(
					({ _id, _creationTime, content, userId, registrationId, ...metadata }) => {
						void _creationTime;
						void content;
						void userId;
						void registrationId;

						return { artifactId: _id, ...metadata };
					}
				)
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
	returns: v.object({ ...pageFields, page: v.array(vProjectArtifact) }),
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await authorizeProject(ctx, repositoryKey, args.threadId);

		return await listVisibleArtifacts(ctx, userId, repositoryKey, args.cursor ?? null);
	}
});

export const getArtifactState = query({
	args: { repositoryKey: v.string(), threadId: v.optional(v.id('threadRecords')) },
	returns: v.number(),
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await authorizeProject(ctx, repositoryKey, args.threadId);

		return (await registryState(ctx, userId, repositoryKey))?.revision ?? 0;
	}
});

export const getArtifactForRun = query({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		artifactId: v.id('artifacts')
	},
	returns: vProjectArtifact,
	handler: async (ctx, args) => {
		try {
			const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
			const repositoryKey = await loadThreadForRun(ctx, run);

			return projectArtifact(
				await requireAccessibleArtifact(ctx, args.artifactId, run.userId, repositoryKey)
			);
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const getArtifact = query({
	args: {
		artifactId: v.id('artifacts'),
		repositoryKey: v.string(),
		threadId: v.optional(v.id('threadRecords'))
	},
	returns: vProjectArtifact,
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await authorizeProject(ctx, repositoryKey, args.threadId);

		return projectArtifact(
			await requireAccessibleArtifact(ctx, args.artifactId, userId, repositoryKey)
		);
	}
});

export const syncArtifact = mutation({
	args: {
		artifactId: v.id('artifacts'),
		repositoryKey: v.string(),
		threadId: v.optional(v.id('threadRecords')),
		expectedRevision: v.number(),
		content: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await authorizeProject(ctx, repositoryKey, args.threadId);
		validateArtifactContent(args.content);

		const artifact = await findAccessibleArtifact(ctx, args.artifactId, userId, repositoryKey);

		if (!artifact || artifact.revision !== args.expectedRevision) {
			return false;
		}

		await writeArtifactFields(ctx, artifact, {
			content: args.content,
			title: artifact.title,
			contentType: artifact.type
		});

		return true;
	}
});
