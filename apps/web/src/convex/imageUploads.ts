import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	internalMutation,
	internalQuery,
	mutation,
	type MutationCtx
} from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getUserId } from '@convex/lib/auth';
import { vRegisterFileResult } from '@convex/lib/docs';
import { registeredFileUploadError } from '@convex/lib/validators';
import { registeredParseStorage } from '@convex/lib/hostedParse';
import { getOwnedImageUploadsByStorageIds, imageUploadByStorageId } from '@convex/lib/imageUploads';
import { internal } from '@convex/_generated/api';

const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1_000;
const ORPHAN_CLEANUP_BATCH_SIZE = 100;
const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type RegisterFileResult = Infer<typeof vRegisterFileResult>;

export const generateUploadUrl = mutation({
	args: {},
	returns: v.string(),
	handler: async (ctx) => {
		await getUserId(ctx);
		return await ctx.storage.generateUploadUrl();
	}
});

export const registerFile = mutation({
	args: {
		storageId: v.id('_storage'),
		name: v.string()
	},
	returns: vRegisterFileResult,
	handler: async (ctx, args) => {
		return await registerOwnedUpload(ctx, args);
	}
});

export const discardFile = mutation({
	args: {
		storageId: v.id('_storage')
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const upload = await imageUploadByStorageId(ctx, args.storageId);
		return await discardOwnedDraft(ctx, userId, upload);
	}
});

export const ownedIdsForStorageIds = internalQuery({
	args: {
		userId: v.string(),
		storageIds: v.array(v.id('_storage'))
	},
	returns: v.array(v.id('imageUploads')),
	handler: async (ctx, args) => {
		const uploads = await getOwnedImageUploadsByStorageIds(ctx, args.userId, args.storageIds);
		return uploads.map((upload) => upload._id);
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
		cursor: v.optional(v.string())
	},
	returns: v.number(),
	handler: async (ctx, args): Promise<number> => {
		const now = Date.now();
		let deleted = 0;
		const page = await ctx.db
			.query('imageUploads')
			.withIndex('by_attached_and_storageDeletedAt', (query) =>
				query.eq('attached', true).eq('storageDeletedAt', undefined)
			)
			.paginate({
				numItems: 8,
				cursor: args.cursor ?? null
			});
		for (const upload of page.page) {
			if (!upload.threadId) {
				await ctx.storage.delete(upload.storageId);
				await ctx.db.delete('imageUploads', upload._id);
				deleted += 1;
				continue;
			}
			const thread = await ctx.db.get('threadRecords', upload.threadId);
			if (!thread || thread.lastMessageAt >= now - ATTACHMENT_RETENTION_MS) continue;
			await ctx.storage.delete(upload.storageId);
			await ctx.db.patch('imageUploads', upload._id, { storageDeletedAt: now });
			deleted += 1;
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.imageUploads.cleanupExpired, {
				cursor: page.continueCursor
			});
		}
		return deleted;
	}
});

async function registerOwnedUpload(
	ctx: MutationCtx,
	args: { storageId: Id<'_storage'>; name: string }
): Promise<RegisterFileResult> {
	const userId = await getUserId(ctx);
	const existing = await imageUploadByStorageId(ctx, args.storageId);
	if (existing) {
		if (existing.userId !== userId) {
			throw new Error('Uploaded file belongs to another user.');
		}
		const url = await ctx.storage.getUrl(existing.storageId);
		return url
			? {
					storageId: existing.storageId,
					name: existing.name,
					mediaType: existing.mediaType,
					size: existing.size,
					url
				}
			: { error: 'Uploaded file is unavailable.' };
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
	return {
		storageId: args.storageId,
		name,
		mediaType,
		size: metadata.size,
		url
	};
}

async function discardOwnedDraft(
	ctx: MutationCtx,
	userId: string,
	upload: Doc<'imageUploads'> | null
): Promise<boolean> {
	if (!upload || upload.userId !== userId || upload.attached) {
		return false;
	}
	await ctx.storage.delete(upload.storageId);
	await ctx.db.delete('imageUploads', upload._id);
	return true;
}
