import type { Doc } from '@convex/_generated/dataModel';
import { internalMutation, mutation, type MutationCtx } from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getOwnerKeys, getUserId } from '@convex/lib/auth';
import { vRegisterImageUploadResult } from '@convex/lib/docs';
import {
	MAX_IMAGE_ATTACHMENT_BYTES,
	MAX_IMAGE_ATTACHMENT_LABEL,
	supportedImageMediaTypes
} from '@convex/lib/validators';

const supportedMediaTypes = new Set<string>(supportedImageMediaTypes);
const MAX_IMAGE_NAME_LENGTH = 255;
const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1_000;
const ORPHAN_CLEANUP_BATCH_SIZE = 100;

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
		const ownerKeys = await getOwnerKeys(ctx);
		const existing = await ctx.db
			.query('imageUploads')
			.withIndex('by_storageId', (query) => query.eq('storageId', args.storageId))
			.unique();
		if (existing) {
			if (existing.userId !== ownerKeys.userId && existing.userId !== ownerKeys.subject) {
				throw new Error('Uploaded image belongs to another user.');
			}
			return await uploadResult(ctx, existing);
		}

		const metadata = await ctx.db.system.get('_storage', args.storageId);
		if (!metadata) {
			return { error: 'Uploaded image was not found.' };
		}

		const name = args.name.trim();
		// Validation failures return (instead of throw) so the storage delete
		// commits; throwing would roll back the whole mutation, delete included.
		if (!name || name.length > MAX_IMAGE_NAME_LENGTH) {
			await ctx.storage.delete(args.storageId);
			return { error: 'Image filename must be between 1 and 255 characters.' };
		}

		const mediaType = metadata.contentType?.toLowerCase() ?? '';
		if (!supportedMediaTypes.has(mediaType)) {
			await ctx.storage.delete(args.storageId);
			return { error: 'Only JPEG, PNG, GIF, and WebP images are supported.' };
		}
		if (metadata.size > MAX_IMAGE_ATTACHMENT_BYTES) {
			await ctx.storage.delete(args.storageId);
			return { error: `Images must be ${MAX_IMAGE_ATTACHMENT_LABEL} or smaller.` };
		}

		const imageUploadId = await ctx.db.insert('imageUploads', {
			userId: ownerKeys.userId,
			storageId: args.storageId,
			name,
			mediaType,
			size: metadata.size,
			messageIds: [],
			attached: false
		});
		const url = await ctx.storage.getUrl(args.storageId);
		if (!url) {
			await ctx.storage.delete(args.storageId);
			await ctx.db.delete('imageUploads', imageUploadId);
			return { error: 'Uploaded image is unavailable.' };
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
		const keys = await getOwnerKeys(ctx);
		const upload = await ctx.db.get('imageUploads', args.imageUploadId);
		if (
			!upload ||
			(upload.userId !== keys.userId && upload.userId !== keys.subject) ||
			upload.attached
		) {
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
			.withIndex('by_attached', (query) =>
				query.eq('attached', false).lt('_creationTime', Date.now() - ORPHAN_RETENTION_MS)
			)
			.take(ORPHAN_CLEANUP_BATCH_SIZE);
		for (const upload of uploads) {
			await ctx.storage.delete(upload.storageId);
			await ctx.db.delete('imageUploads', upload._id);
		}
		return uploads.length;
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
		: { error: 'Uploaded image is unavailable.' };
}
