import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';

export async function imageUploadByStorageId(
	ctx: MutationCtx | QueryCtx,
	storageId: Id<'_storage'>
): Promise<Doc<'imageUploads'> | null> {
	return await ctx.db
		.query('imageUploads')
		.withIndex('by_storageId', (query) => query.eq('storageId', storageId))
		.unique();
}
