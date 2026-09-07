import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';

export function areStorageIdsEqual(
	left: readonly Id<'_storage'>[] | undefined,
	right: readonly Id<'_storage'>[] | undefined
): boolean {
	const leftIds = left ?? [];
	const rightIds = right ?? [];
	return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

export function assertExclusiveAttachmentIdentity(args: {
	storageIds?: unknown;
	imageUploadIds?: unknown;
}): void {
	if (args.storageIds !== undefined && args.imageUploadIds !== undefined) {
		throw new Error('Provide storageIds or imageUploadIds, not both.');
	}
}

export async function imageUploadByStorageId(
	ctx: MutationCtx | QueryCtx,
	storageId: Id<'_storage'>
): Promise<Doc<'imageUploads'> | null> {
	return await ctx.db
		.query('imageUploads')
		.withIndex('by_storageId', (query) => query.eq('storageId', storageId))
		.unique();
}

export async function getOwnedImageUploads(
	ctx: MutationCtx | QueryCtx,
	userId: string,
	imageUploadIds: Id<'imageUploads'>[]
): Promise<Doc<'imageUploads'>[]> {
	assertUniqueAttachmentIds(imageUploadIds);
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

export async function getOwnedImageUploadsByStorageIds(
	ctx: MutationCtx | QueryCtx,
	userId: string,
	storageIds: Id<'_storage'>[]
): Promise<Doc<'imageUploads'>[]> {
	assertUniqueAttachmentIds(storageIds);
	return await Promise.all(
		storageIds.map(async (storageId) => {
			const upload = await imageUploadByStorageId(ctx, storageId);
			if (!upload || upload.userId !== userId) {
				throw new Error('File attachment was not found.');
			}
			return upload;
		})
	);
}

export async function storageIdsForImageUploadIds(
	ctx: MutationCtx | QueryCtx,
	imageUploadIds: Id<'imageUploads'>[]
): Promise<Id<'_storage'>[] | null> {
	const storageIds: Id<'_storage'>[] = [];
	for (const imageUploadId of imageUploadIds) {
		const upload = await ctx.db.get('imageUploads', imageUploadId);
		if (!upload) return null;
		storageIds.push(upload.storageId);
	}
	return storageIds;
}

export async function markImageUploadsAttached(
	ctx: MutationCtx,
	uploads: Doc<'imageUploads'>[],
	threadId: Id<'threadRecords'>
): Promise<void> {
	for (const upload of uploads) {
		if (!upload.attached) {
			await ctx.db.patch('imageUploads', upload._id, {
				attached: true,
				threadId
			});
		}
	}
}

function assertUniqueAttachmentIds(ids: string[]): void {
	if (new Set(ids).size !== ids.length) {
		throw new Error('The same file cannot be attached more than once.');
	}
}
