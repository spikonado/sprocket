import type { Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';

/** Fold `dropId`'s versions into `keepId`, then delete the empty duplicate row.
 * Same-title artifacts are unique per thread; concurrent creates / thread absorb
 * must not throw away content that landed on the losing row.
 * Versions are reordered by `createdAt` so interleaved histories stay chronological.
 * Equal-content rows are kept (renumbered) so history/timestamps are not erased. */
export async function absorbDuplicateArtifact(
	ctx: MutationCtx,
	keepId: Id<'artifacts'>,
	dropId: Id<'artifacts'>
): Promise<void> {
	if (keepId === dropId) return;

	const keep = await ctx.db.get('artifacts', keepId);
	const drop = await ctx.db.get('artifacts', dropId);
	if (!keep || !drop) return;

	const keepVersions = await ctx.db
		.query('artifactVersions')
		.withIndex('by_artifactId_version', (query) => query.eq('artifactId', keepId))
		.collect();
	const dropVersions = await ctx.db
		.query('artifactVersions')
		.withIndex('by_artifactId_version', (query) => query.eq('artifactId', dropId))
		.collect();

	const merged = [...keepVersions, ...dropVersions].sort(
		(a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id)
	);

	let versionNumber = 0;
	let updatedAt = keep.updatedAt;

	for (const row of merged) {
		versionNumber += 1;
		updatedAt = Math.max(updatedAt, row.createdAt);
		if (row.artifactId !== keepId || row.version !== versionNumber) {
			await ctx.db.patch('artifactVersions', row._id, {
				artifactId: keepId,
				version: versionNumber
			});
		}
	}

	if (keep.currentVersion !== versionNumber || keep.updatedAt !== updatedAt) {
		await ctx.db.patch('artifacts', keepId, {
			currentVersion: versionNumber,
			updatedAt
		});
	}

	await ctx.db.delete('artifacts', dropId);
}
