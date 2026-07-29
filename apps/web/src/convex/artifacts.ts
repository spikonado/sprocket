import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnedThreadRecord } from '@convex/lib/access';
import { getExecutionRun, getUserId } from '@convex/lib/auth';
import { vArtifactType } from '@convex/lib/validators';
import { ownsActiveRunClaim } from '@convex/lib/runLease';
import { RUN_NO_LONGER_ACTIVE } from '@convex/lib/agentErrors';

const MAX_TITLE_LENGTH = 200;
// Content also lives in the executor job payload; stay well under Convex's 1 MiB document cap.
const MAX_CONTENT_LENGTH = 500_000;

const vArtifactMutationResult = v.object({
	artifactId: v.id('artifacts'),
	version: v.number(),
	title: v.string(),
	contentType: vArtifactType
});

function validateArtifactTitle(title: string) {
	if (!title) {
		throw new Error('Artifact title cannot be empty.');
	}
	if (title.length > MAX_TITLE_LENGTH) {
		throw new Error(`Artifact title cannot exceed ${MAX_TITLE_LENGTH} characters.`);
	}
}

function validateArtifactContent(content: string) {
	if (!content) {
		throw new Error('Artifact content cannot be empty.');
	}
	if (content.length > MAX_CONTENT_LENGTH) {
		throw new Error(`Artifact content cannot exceed ${MAX_CONTENT_LENGTH} characters.`);
	}
}

async function requireActiveRun(
	ctx: MutationCtx,
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

function latestArtifactVersion(ctx: QueryCtx | MutationCtx, artifactId: Id<'artifacts'>) {
	return ctx.db
		.query('artifactVersions')
		.withIndex('by_artifactId_version', (q) => q.eq('artifactId', artifactId))
		.order('desc')
		.first();
}

/** Stores `content` as the artifact's next version and points the artifact at it. */
async function insertNextVersion(
	ctx: MutationCtx,
	artifact: Doc<'artifacts'>,
	userId: string,
	latest: Doc<'artifactVersions'> | null,
	content: string
): Promise<number> {
	const version = Math.max(artifact.currentVersion, latest?.version ?? 0) + 1;
	const now = Date.now();

	await ctx.db.insert('artifactVersions', {
		artifactId: artifact._id,
		userId,
		version,
		content,
		createdAt: now
	});

	await ctx.db.patch(artifact._id, {
		currentVersion: version,
		updatedAt: now
	});

	return version;
}

function mutationResult(artifact: Doc<'artifacts'>, version: number) {
	return {
		artifactId: artifact._id,
		version,
		title: artifact.title,
		contentType: artifact.type
	};
}

export const createArtifact = mutation({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		title: v.string(),
		contentType: vArtifactType,
		content: v.string(),
		executionSecret: v.string()
	},
	returns: vArtifactMutationResult,
	handler: async (ctx, args) => {
		const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
		const userId = run.userId;
		const threadId = run.threadId;
		await getOwnedThreadRecord(ctx.db, userId, threadId);

		const title = args.title.trim();
		validateArtifactTitle(title);
		validateArtifactContent(args.content);

		// A repeated title in the same thread updates the existing artifact
		// instead of silently dropping the new content.
		const existing = await ctx.db
			.query('artifacts')
			.withIndex('by_threadId_title', (q) => q.eq('threadId', threadId).eq('title', title))
			.first();

		if (existing) {
			const latest = await latestArtifactVersion(ctx, existing._id);
			const version =
				latest?.content === args.content
					? existing.currentVersion
					: await insertNextVersion(ctx, existing, userId, latest, args.content);

			return mutationResult(existing, version);
		}

		const now = Date.now();
		const artifactId = await ctx.db.insert('artifacts', {
			threadId,
			userId,
			title,
			type: args.contentType,
			currentVersion: 1,
			createdById: run._id,
			createdAt: now,
			updatedAt: now
		});

		await ctx.db.insert('artifactVersions', {
			artifactId,
			userId,
			version: 1,
			content: args.content,
			createdAt: now
		});

		return { artifactId, version: 1, title, contentType: args.contentType };
	}
});

export const appendArtifactVersion = mutation({
	args: {
		artifactId: v.id('artifacts'),
		runId: v.id('runs'),
		claimId: v.string(),
		content: v.string(),
		executionSecret: v.string()
	},
	returns: vArtifactMutationResult,
	handler: async (ctx, args) => {
		const run = await requireActiveRun(ctx, args.runId, args.claimId, args.executionSecret);
		const userId = run.userId;

		const artifact: Doc<'artifacts'> | null = await ctx.db.get(args.artifactId);
		if (!artifact || artifact.userId !== userId || artifact.threadId !== run.threadId) {
			throw new Error('Artifact not found.');
		}
		await getOwnedThreadRecord(ctx.db, userId, artifact.threadId);

		validateArtifactContent(args.content);

		const latest = await latestArtifactVersion(ctx, args.artifactId);
		const version = await insertNextVersion(ctx, artifact, userId, latest, args.content);

		return mutationResult(artifact, version);
	}
});

export const getArtifact = query({
	args: {
		artifactId: v.id('artifacts')
	},
	handler: async (
		ctx,
		args
	): Promise<{
		artifact: Doc<'artifacts'>;
		versions: Doc<'artifactVersions'>[];
	}> => {
		const userId: string = await getUserId(ctx);
		const artifact: Doc<'artifacts'> | null = await ctx.db.get(args.artifactId);
		if (!artifact || artifact.userId !== userId) {
			throw new Error('Artifact not found.');
		}
		await getOwnedThreadRecord(ctx.db, userId, artifact.threadId);

		const versions = await ctx.db
			.query('artifactVersions')
			.withIndex('by_artifactId_version', (q) => q.eq('artifactId', args.artifactId))
			.order('asc')
			.collect();

		return { artifact, versions };
	}
});

export const listArtifactsForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	handler: async (
		ctx,
		args
	): Promise<
		{
			artifact: Doc<'artifacts'>;
			currentContent: string;
		}[]
	> => {
		const userId: string = await getUserId(ctx);
		await getOwnedThreadRecord(ctx.db, userId, args.threadId);

		const artifacts = await ctx.db
			.query('artifacts')
			.withIndex('by_threadId', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.collect();

		const results = [];
		for (const artifact of artifacts) {
			const latest = await latestArtifactVersion(ctx, artifact._id);
			if (latest) {
				results.push({
					artifact,
					currentContent: latest.content
				});
			}
		}

		return results;
	}
});
