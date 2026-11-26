import { ConvexError, v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { internalAction, internalMutation, mutation } from '@convex/_generated/server';
import { getExecutionRunRecord, getUserId } from '@convex/lib/auth';
import { addStorageBytes, deleteFile, firstFileWithBlob, storageUsage } from '@convex/lib/files';
import { deleteObject, fileKey, presignDownload, presignUpload } from '@convex/lib/r2';
import { resolvePlan } from '@convex/lib/tiers';
import { registeredFileUploadError } from '@convex/lib/validators';

// R2's limit for a single PUT.
const MAX_FILE_BYTES = 5 * 1024 ** 3;

const DRAFT_RETENTION_MS = 24 * 60 * 60 * 1_000;

const DRAFT_CLEANUP_BATCH_SIZE = 100;

const SHA256_HEX = /^[0-9a-f]{64}$/;

const BLOB_DELETE_FIRST_RETRY_MS = 60 * 1_000;

const BLOB_DELETE_MAX_RETRY_MS = 60 * 60 * 1_000;

const vUpload = v.object({ url: v.string(), headers: v.record(v.string(), v.string()) });

const vFileMetadata = v.object({
	name: v.string(),
	mediaType: v.string(),
	size: v.number()
});

/** Creates a draft file. `upload` is null when the user already stored the same bytes. */
export const createUpload = mutation({
	args: { name: v.string(), mediaType: v.string(), size: v.number(), sha256: v.string() },
	returns: v.object({
		file: vFileMetadata.extend({ fileId: v.id('files') }),
		upload: v.union(vUpload, v.null())
	}),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const name = args.name.trim();
		const nameError = registeredFileUploadError(name);

		if (nameError) throw new ConvexError(nameError);

		if (!SHA256_HEX.test(args.sha256)) throw new Error('File hash must be a lowercase hex sha256.');

		if (!Number.isSafeInteger(args.size) || args.size < 0 || args.size > MAX_FILE_BYTES) {
			throw new ConvexError('Files can be at most 5 GiB.');
		}

		const sameBlob = await firstFileWithBlob(ctx, userId, args.sha256);

		if (!sameBlob) {
			const { limits } = await resolvePlan(ctx, userId, Date.now());
			const used = (await storageUsage(ctx, userId))?.bytes ?? 0;

			if (limits.storageBytes !== undefined && used + args.size > limits.storageBytes) {
				throw new ConvexError('File storage limit reached.');
			}

			await addStorageBytes(ctx, userId, args.size);
		}

		const metadata = {
			name,
			mediaType: args.mediaType.trim().toLowerCase() || 'application/octet-stream',
			size: sameBlob?.size ?? args.size
		};

		const blobId = sameBlob?.blobId ?? crypto.randomUUID();

		const fileId = await ctx.db.insert('files', {
			userId,
			sha256: args.sha256,
			blobId,
			...metadata
		});

		return {
			file: { fileId, ...metadata },
			// Sent files finished uploading; drafts may still be uploading.
			upload: sameBlob?.threadId
				? null
				: await presignUpload(fileKey(userId, blobId), {
						sha256: args.sha256,
						size: metadata.size
					})
		};
	}
});

export const discard = mutation({
	args: { fileId: v.id('files') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const file = await ctx.db.get('files', args.fileId);

		if (!file || file.userId !== userId || file.threadId) return false;
		await deleteFile(ctx, file);

		return true;
	}
});

export const downloadUrl = mutation({
	args: { fileId: v.id('files') },
	returns: v.union(vFileMetadata.extend({ url: v.string() }), v.null()),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const file = await ctx.db.get('files', args.fileId);

		if (!file || file.userId !== userId) return null;

		return {
			name: file.name,
			mediaType: file.mediaType,
			size: file.size,
			url: await presignDownload(fileKey(userId, file.blobId))
		};
	}
});

export const urlForRun = mutation({
	args: { runId: v.id('runs'), executionSecret: v.string(), fileId: v.id('files') },
	returns: v.string(),
	handler: async (ctx, args) => {
		const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);
		const file = await ctx.db.get('files', args.fileId);

		if (!file || file.userId !== run.userId) throw new Error('File attachment was not found.');

		return await presignDownload(fileKey(file.userId, file.blobId));
	}
});

export const cleanupDrafts = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const drafts = await ctx.db
			.query('files')
			.withIndex('by_threadId', (query) =>
				query.eq('threadId', undefined).lt('_creationTime', Date.now() - DRAFT_RETENTION_MS)
			)
			.take(DRAFT_CLEANUP_BATCH_SIZE);

		for (const draft of drafts) await deleteFile(ctx, draft);

		if (drafts.length === DRAFT_CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.files.cleanupDrafts, {});
		}

		return null;
	}
});

export const deleteBlob = internalAction({
	args: { userId: v.string(), blobId: v.string(), attempt: v.optional(v.number()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const attempt = args.attempt ?? 0;

		try {
			await deleteObject(fileKey(args.userId, args.blobId));
		} catch (error) {
			console.error(`R2 delete attempt ${attempt + 1} failed; retrying.`, error);
			const delay = Math.min(BLOB_DELETE_FIRST_RETRY_MS * 2 ** attempt, BLOB_DELETE_MAX_RETRY_MS);

			await ctx.scheduler.runAfter(delay, internal.files.deleteBlob, {
				...args,
				attempt: attempt + 1
			});
		}

		return null;
	}
});
