import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';

export function areImageUploadIdsEqual(
	left: Id<'imageUploads'>[] | undefined,
	right: Id<'imageUploads'>[] | undefined
): boolean {
	const leftIds = left ?? [];
	const rightIds = right ?? [];
	return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

export async function getOwnedImageUploads(
	ctx: MutationCtx | QueryCtx,
	userId: string,
	imageUploadIds: Id<'imageUploads'>[]
): Promise<Doc<'imageUploads'>[]> {
	if (new Set(imageUploadIds).size !== imageUploadIds.length) {
		throw new Error('The same file cannot be attached more than once.');
	}

	return await Promise.all(
		imageUploadIds.map(async (imageUploadId) => {
			const upload = await ctx.db.get('imageUploads', imageUploadId);
			if (!upload || upload.userId !== userId) {
				throw new Error('File attachment was not found.');
			}
			return upload;
		})
	);
}

export async function markImageUploadsAttached(
	ctx: MutationCtx,
	uploads: Doc<'imageUploads'>[]
): Promise<void> {
	for (const upload of uploads) {
		if (!upload.attached) {
			await ctx.db.patch('imageUploads', upload._id, {
				attached: true,
				threadRefsMigratedAt: Date.now()
			});
		}
	}
}
