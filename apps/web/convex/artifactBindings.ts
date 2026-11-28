import { query, type QueryCtx } from '@convex/_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { getUserId } from '@convex/lib/auth';
import schema from '@convex/schema';

const args = { artifactIds: v.array(v.id('artifacts')) };

async function loadBindings(ctx: QueryCtx, artifactIds: Id<'artifacts'>[]) {
	const userId = await getUserId(ctx);

	if (artifactIds.length > 8) throw new Error('At most 8 artifact bindings may be read at once.');

	const artifacts = await Promise.all(
		[...new Set(artifactIds)].map((id) => ctx.db.get('artifacts', id))
	);

	return artifacts.filter(
		(artifact): artifact is Doc<'artifacts'> => artifact !== null && artifact.userId === userId
	);
}

export const getArtifacts = query({
	args,
	returns: v.array(schema.doc('artifacts')),
	handler: (ctx, args) => loadBindings(ctx, args.artifactIds)
});

export const getState = query({
	args,
	returns: v.array(
		v.object({ artifactId: v.id('artifacts'), repositoryKey: v.string(), revision: v.number() })
	),
	handler: async (ctx, args) =>
		(await loadBindings(ctx, args.artifactIds)).map((artifact) => ({
			artifactId: artifact._id,
			repositoryKey: artifact.repositoryKey,
			revision: artifact.revision
		}))
});
