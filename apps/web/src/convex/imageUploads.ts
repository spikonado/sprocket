import type { Doc, Id } from '@convex/_generated/dataModel';
import { internalMutation, mutation, type MutationCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { vRegisterImageUploadResult } from '@convex/lib/docs';
import { registeredFileUploadError } from '@convex/lib/validators';
import { registeredParseStorage } from '@convex/lib/hostedParse';
import { internal } from '@convex/_generated/api';
import {
	ATTACHMENT_CLEANUP_UPLOAD_BATCH,
	expireUploadIfInactive
} from '@convex/lib/attachmentRetention';

const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1_000;
const ORPHAN_CLEANUP_BATCH_SIZE = 100;

type ExpiredCleanupArgs = {
	cursor?: string | null;
	remainingUploadIds?: Id<'imageUploads'>[];
	continueUploadId?: Id<'imageUploads'>;
	exclusiveThreadId?: Id<'threadRecords'>;
	activityFenceAt?: number;
};

function expiredCleanupArgs(args: ExpiredCleanupArgs): ExpiredCleanupArgs {
	const next: ExpiredCleanupArgs = {};
	if (args.cursor !== undefined) next.cursor = args.cursor;
	if (args.remainingUploadIds && args.remainingUploadIds.length > 0) {
		next.remainingUploadIds = args.remainingUploadIds;
	}
	if (args.continueUploadId !== undefined) next.continueUploadId = args.continueUploadId;
	if (args.exclusiveThreadId !== undefined) next.exclusiveThreadId = args.exclusiveThreadId;
	if (args.activityFenceAt !== undefined) next.activityFenceAt = args.activityFenceAt;
	return next;
}

export type RegisterImageUploadResult = Infer<typeof vRegisterImageUploadResult>;

export const generateUploadUrl = mutation({
	args: {},
	returns: v.string(),
	handler: async (ctx) => {
		await getUserId(ctx);
		return await ctx.storage.generateUploadUrl();
	}
});

export const register = mutation({
	args: {
		storageId: v.id('_storage'),
		name: v.string()
	},
	returns: vRegisterImageUploadResult,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const existing = await ctx.db
			.query('imageUploads')
			.withIndex('by_storageId', (query) => query.eq('storageId', args.storageId))
			.unique();
		if (existing) {
			if (existing.userId !== userId) {
				throw new Error('Uploaded file belongs to another user.');
			}
			return await uploadResult(ctx, existing);
		}

		if (await registeredParseStorage(ctx, args.storageId)) {
			return { error: 'Temporary parse files cannot be registered as attachments.' };
		}
		const metadata = await ctx.db.system.get('_storage', args.storageId);
		if (!metadata) {
			return { error: 'Uploaded file was not found.' };
		}

		const name = args.name.trim();
		const mediaType = (metadata.contentType?.trim() || 'application/octet-stream').toLowerCase();
		// Validation failures return (instead of throw) so the storage delete
		// commits; throwing would roll back the whole mutation, delete included.
		const validationError = registeredFileUploadError(name);
		if (validationError) {
			await ctx.storage.delete(args.storageId);
			return { error: validationError };
		}

		const imageUploadId = await ctx.db.insert('imageUploads', {
			userId,
			storageId: args.storageId,
			name,
			mediaType,
			size: metadata.size,
			attached: false
		});
		const url = await ctx.storage.getUrl(args.storageId);
		if (!url) {
			await ctx.storage.delete(args.storageId);
			await ctx.db.delete('imageUploads', imageUploadId);
			return { error: 'Uploaded file is unavailable.' };
		}
		return { imageUploadId, name, mediaType, size: metadata.size, url };
	}
});

export const discard = mutation({
	args: {
		imageUploadId: v.id('imageUploads')
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const upload = await ctx.db.get('imageUploads', args.imageUploadId);
		if (!upload || upload.userId !== userId || upload.attached) {
			return false;
		}
		await ctx.storage.delete(upload.storageId);
		await ctx.db.delete('imageUploads', upload._id);
		return true;
	}
});

export const cleanupOrphans = internalMutation({
	args: {},
	returns: v.number(),
	handler: async (ctx) => {
		const uploads = await ctx.db
			.query('imageUploads')
			.withIndex('by_attached_and_storageDeletedAt', (query) =>
				query
					.eq('attached', false)
					.eq('storageDeletedAt', undefined)
					.lt('_creationTime', Date.now() - ORPHAN_RETENTION_MS)
			)
			.take(ORPHAN_CLEANUP_BATCH_SIZE);
		for (const upload of uploads) {
			await ctx.storage.delete(upload.storageId);
			await ctx.db.delete('imageUploads', upload._id);
		}
		return uploads.length;
	}
});

export const cleanupExpired = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		remainingUploadIds: v.optional(v.array(v.id('imageUploads'))),
		continueUploadId: v.optional(v.id('imageUploads')),
		exclusiveThreadId: v.optional(v.id('threadRecords')),
		activityFenceAt: v.optional(v.number())
	},
	returns: v.number(),
	handler: async (ctx, args): Promise<number> => {
		const now = Date.now();
		let deleted = 0;
		const remainingUploadIds = [...(args.remainingUploadIds ?? [])];

		if (args.continueUploadId) {
			const continued = await ctx.db.get('imageUploads', args.continueUploadId);
			if (continued) {
				const result = await expireUploadIfInactive(ctx, continued, now, {
					exclusiveThreadId: args.exclusiveThreadId,
					activityFenceAt: args.activityFenceAt
				});
				deleted += result.deleted;
				if (result.continueFromThreadId !== undefined) {
					await ctx.scheduler.runAfter(
						0,
						internal.imageUploads.cleanupExpired,
						expiredCleanupArgs({
							cursor: args.cursor,
							remainingUploadIds,
							continueUploadId: continued._id,
							exclusiveThreadId: result.continueFromThreadId,
							activityFenceAt: result.activityFenceAt
						})
					);
					return deleted;
				}
			}
			if (remainingUploadIds.length > 0 || args.cursor !== undefined) {
				await ctx.scheduler.runAfter(
					0,
					internal.imageUploads.cleanupExpired,
					expiredCleanupArgs({ cursor: args.cursor, remainingUploadIds })
				);
			}
			return deleted;
		}

		while (remainingUploadIds.length > 0) {
			const uploadId = remainingUploadIds.shift();
			if (!uploadId) break;
			const upload = await ctx.db.get('imageUploads', uploadId);
			if (!upload) continue;
			const result = await expireUploadIfInactive(ctx, upload, now);
			deleted += result.deleted;
			if (result.continueFromThreadId !== undefined) {
				await ctx.scheduler.runAfter(
					0,
					internal.imageUploads.cleanupExpired,
					expiredCleanupArgs({
						cursor: args.cursor,
						remainingUploadIds,
						continueUploadId: upload._id,
						exclusiveThreadId: result.continueFromThreadId,
						activityFenceAt: result.activityFenceAt
					})
				);
				return deleted;
			}
			if (remainingUploadIds.length > 0 || args.cursor !== undefined) {
				await ctx.scheduler.runAfter(
					0,
					internal.imageUploads.cleanupExpired,
					expiredCleanupArgs({ cursor: args.cursor, remainingUploadIds })
				);
			}
			return deleted;
		}

		const page = await ctx.db
			.query('imageUploads')
			.withIndex('by_attached_and_storageDeletedAt', (query) =>
				query.eq('attached', true).eq('storageDeletedAt', undefined)
			)
			.paginate({
				numItems: ATTACHMENT_CLEANUP_UPLOAD_BATCH,
				cursor: args.cursor ?? null
			});
		const nextCursor = page.isDone ? undefined : page.continueCursor;

		for (const [index, upload] of page.page.entries()) {
			const result = await expireUploadIfInactive(ctx, upload, now);
			deleted += result.deleted;
			if (result.continueFromThreadId !== undefined) {
				await ctx.scheduler.runAfter(
					0,
					internal.imageUploads.cleanupExpired,
					expiredCleanupArgs({
						cursor: nextCursor,
						remainingUploadIds: page.page.slice(index + 1).map((row) => row._id),
						continueUploadId: upload._id,
						exclusiveThreadId: result.continueFromThreadId,
						activityFenceAt: result.activityFenceAt
					})
				);
				return deleted;
			}
		}

		if (nextCursor !== undefined) {
			await ctx.scheduler.runAfter(0, internal.imageUploads.cleanupExpired, { cursor: nextCursor });
		}
		return deleted;
	}
});

async function uploadResult(
	ctx: MutationCtx,
	upload: Doc<'imageUploads'>
): Promise<RegisterImageUploadResult> {
	const url = await ctx.storage.getUrl(upload.storageId);
	return url
		? {
				imageUploadId: upload._id,
				name: upload.name,
				mediaType: upload.mediaType,
				size: upload.size,
				url
			}
		: { error: 'Uploaded file is unavailable.' };
}
