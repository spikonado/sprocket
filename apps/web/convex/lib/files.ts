import { internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { UPLOAD_URL_TTL_SECONDS } from '@convex/lib/r2';

// The extra hour covers a PUT that R2 accepted just before its URL expired and clock skew.
const BLOB_DELETE_DELAY_MS = (UPLOAD_URL_TTL_SECONDS + 60 * 60) * 1_000;

/** Prefers a sent file, since drafts have no `threadId` and sort first. */
export async function firstFileWithBlob(
	ctx: QueryCtx,
	userId: string,
	sha256: string
): Promise<Doc<'files'> | null> {
	return await ctx.db
		.query('files')
		.withIndex('by_userId_and_sha256_and_threadId', (query) =>
			query.eq('userId', userId).eq('sha256', sha256)
		)
		.order('desc')
		.first();
}

export async function storageUsage(
	ctx: QueryCtx,
	userId: string
): Promise<Doc<'storageUsage'> | null> {
	return await ctx.db
		.query('storageUsage')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.unique();
}

export async function addStorageBytes(
	ctx: MutationCtx,
	userId: string,
	bytes: number
): Promise<void> {
	const usage = await storageUsage(ctx, userId);

	if (usage) {
		await ctx.db.patch('storageUsage', usage._id, { bytes: usage.bytes + bytes });
	} else {
		await ctx.db.insert('storageUsage', { userId, bytes });
	}
}

/**
 * Deletes the blob too once no file of its user references it. The delete waits until upload
 * URLs for the blob expire, so a late PUT can't leave an untracked object behind.
 */
export async function deleteFile(ctx: MutationCtx, file: Doc<'files'>): Promise<void> {
	await ctx.db.delete('files', file._id);

	if (await firstFileWithBlob(ctx, file.userId, file.sha256)) return;
	await addStorageBytes(ctx, file.userId, -file.size);
	await ctx.scheduler.runAfter(BLOB_DELETE_DELAY_MS, internal.files.deleteBlob, {
		userId: file.userId,
		blobId: file.blobId
	});
}

export async function getOwnedFiles(
	ctx: QueryCtx,
	userId: string,
	fileIds: Id<'files'>[]
): Promise<Doc<'files'>[]> {
	if (new Set(fileIds).size !== fileIds.length) {
		throw new Error('The same file cannot be attached more than once.');
	}

	return await Promise.all(
		fileIds.map(async (fileId) => {
			const file = await ctx.db.get('files', fileId);

			if (!file || file.userId !== userId) throw new Error('File attachment was not found.');

			return file;
		})
	);
}

export async function attachFiles(
	ctx: MutationCtx,
	files: Doc<'files'>[],
	threadId: Id<'threadRecords'>
): Promise<void> {
	for (const file of files) {
		if (file.threadId === threadId) continue;

		if (file.threadId) throw new Error('File attachment was not found.');
		await ctx.db.patch('files', file._id, { threadId });
	}
}

export function attachmentMeta(file: Doc<'files'>) {
	return {
		name: file.name,
		mediaType: file.mediaType,
		size: file.size,
		fileId: file._id,
		storageId: file._id
	};
}
