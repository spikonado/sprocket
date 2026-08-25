import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { MAX_IMAGE_ATTACHMENTS } from '@convex/lib/validators';

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
	if (imageUploadIds.length > MAX_IMAGE_ATTACHMENTS) {
		throw new Error(`Attach at most ${MAX_IMAGE_ATTACHMENTS} images.`);
	}
	if (new Set(imageUploadIds).size !== imageUploadIds.length) {
		throw new Error('The same image cannot be attached more than once.');
	}

	return await Promise.all(
		imageUploadIds.map(async (imageUploadId) => {
			const upload = await ctx.db.get('imageUploads', imageUploadId);
			if (!upload || upload.userId !== userId) {
				throw new Error('Image attachment was not found.');
			}
			return upload;
		})
	);
}

export async function attachImageUploads(
	ctx: MutationCtx,
	uploads: Doc<'imageUploads'>[],
	messageId: Id<'threadMessages'>
): Promise<void> {
	for (const upload of uploads) {
		if (!upload.messageIds.includes(messageId)) {
			await ctx.db.patch('imageUploads', upload._id, {
				messageIds: [...upload.messageIds, messageId],
				attached: true
			});
		}
	}
}
