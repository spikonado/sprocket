import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import { MAX_FILE_NAME_LENGTH, vLegacyArtifactType } from '@convex/lib/validators';
import schema from '@convex/schema';
import { registryState, bumpRegistry } from '@convex/lib/artifactRegistry';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { RUN_NO_LONGER_ACTIVE, toAgentToolConvexError } from '@convex/lib/agentErrors';

const MAX_TITLE_LENGTH = MAX_FILE_NAME_LENGTH;

const MAX_ARTIFACT_CONTENT_BYTES = 500_000;

const vArtifactMutationResult = v.object({ artifactId: v.id('artifacts') });

// Released clients require `type` on stored artifacts and send `contentType`.
const vProjectArtifact = schema.doc('artifacts').omit('type').extend({ type: vLegacyArtifactType });

function withLegacyType(artifact: Doc<'artifacts'>) {
	const extension = /\.([^.]+)$/.exec(artifact.title)?.[1]?.toLowerCase();

	const type =
		extension === 'html' || extension === 'htm'
			? ('html' as const)
			: extension === 'jsx'
				? ('react' as const)
				: ('markdown' as const);

	return { ...artifact, type };
}

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
		page: result.page,
		isDone: result.isDone,
		continueCursor: result.continueCursor,
		revision: (await registryState(ctx, userId, repositoryKey))?.revision ?? 0
	};
}

const pageFields = { isDone: v.boolean(), continueCursor: v.string(), revision: v.number() };

function canAccessArtifact(
	artifact: Doc<'artifacts'>,
	userId: string,
	repositoryKey: string
): boolean {
	return artifact.userId === userId && artifact.repositoryKey === repositoryKey;
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
	}
): Promise<void> {
	if (artifact.content === fields.content && artifact.title === fields.title) return;

	await ctx.db.patch('artifacts', artifact._id, {
		content: fields.content,
		title: fields.title,
		revision: artifact.revision + 1,
		updatedAt: Date.now()
	});
	await bumpRegistry(ctx, artifact.userId, artifact.repositoryKey);
}

export const addArtifact = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string(),
		registrationId: v.string(),
		content: v.string(),
		title: v.string(),
		contentType: v.optional(vLegacyArtifactType)
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

				return { artifactId: existing._id };
			}

			const record: Omit<Doc<'artifacts'>, '_id' | '_creationTime'> = {
				userId: run.userId,
				scope: 'project',
				repositoryKey,
				registrationId: args.registrationId,
				content: args.content,
				title,
				revision: 1,
				updatedAt: Date.now()
			};

			const artifactId = await ctx.db.insert('artifacts', record);
			await bumpRegistry(ctx, run.userId, repositoryKey);

			return { artifactId };
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
		contentType: v.optional(vLegacyArtifactType)
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

			await writeArtifactFields(ctx, artifact, { content: args.content, title });

			return { artifactId: artifact._id };
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const deleteArtifact = mutation({
	args: { artifactId: v.id('artifacts'), repositoryKey: v.string() },
	returns: vArtifactMutationResult,
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await getUserId(ctx);

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
	returns: vArtifactMutationResult,
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
		page: v.array(v.object({ artifactId: v.id('artifacts'), title: v.string() }))
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
				page: result.page.map(({ _id, title }) => ({ artifactId: _id, title }))
			};
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});

export const listArtifacts = query({
	args: {
		repositoryKey: v.string(),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	returns: v.object({
		...pageFields,
		page: v.array(vProjectArtifact.extend({ createdAt: v.number() }))
	}),
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await getUserId(ctx);
		const result = await listVisibleArtifacts(ctx, userId, repositoryKey, args.cursor ?? null);

		return {
			...result,
			page: result.page.map((artifact) => ({
				...withLegacyType(artifact),
				createdAt: Math.floor(artifact._creationTime)
			}))
		};
	}
});

export const getArtifactState = query({
	args: { repositoryKey: v.string() },
	returns: v.number(),
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await getUserId(ctx);

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

			return withLegacyType(
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
		repositoryKey: v.string()
	},
	returns: vProjectArtifact,
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await getUserId(ctx);

		return withLegacyType(
			await requireAccessibleArtifact(ctx, args.artifactId, userId, repositoryKey)
		);
	}
});

export const syncArtifact = mutation({
	args: {
		artifactId: v.id('artifacts'),
		repositoryKey: v.string(),
		expectedRevision: v.number(),
		content: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const repositoryKey = validateRepositoryKey(args.repositoryKey);
		const userId = await getUserId(ctx);
		validateArtifactContent(args.content);

		const artifact = await findAccessibleArtifact(ctx, args.artifactId, userId, repositoryKey);

		if (!artifact || artifact.revision !== args.expectedRevision) {
			return false;
		}

		await writeArtifactFields(ctx, artifact, { content: args.content, title: artifact.title });

		return true;
	}
});
