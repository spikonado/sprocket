import type { MutationCtx, QueryCtx } from '@convex/_generated/server';

export async function registryState(ctx: QueryCtx, userId: string, repositoryKey: string) {
	return await ctx.db
		.query('artifactRegistries')
		.withIndex('by_userId_and_repositoryKey', (q) =>
			q.eq('userId', userId).eq('repositoryKey', repositoryKey)
		)
		.unique();
}

export async function bumpRegistry(ctx: MutationCtx, userId: string, repositoryKey: string) {
	const state = await registryState(ctx, userId, repositoryKey);

	if (state) await ctx.db.patch('artifactRegistries', state._id, { revision: state.revision + 1 });
	else await ctx.db.insert('artifactRegistries', { userId, repositoryKey, revision: 1 });
}
