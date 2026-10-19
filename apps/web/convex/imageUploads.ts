import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	internalMutation,
	internalQuery,
	mutation,
	type MutationCtx
} from '@convex/_generated/server';
import { v, type Infer } from 'convex/values';
import { getExecutionRunRecord, getUserId } from '@convex/lib/auth';
import { vRegisterFileResult } from '@convex/lib/docs';
import { isRunFinalStatus, registeredFileUploadError } from '@convex/lib/validators';
import { registeredParseStorage } from '@convex/lib/hostedParse';
import {
	getOwnedImageUploadsByStorageIds,
	imageUploadByStorageId,
	liveToolImage
} from '@convex/lib/imageUploads';
import { internal } from '@convex/_generated/api';

const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1_000;

const ORPHAN_CLEANUP_BATCH_SIZE = 100;

const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const MAX_TOOL_IMAGES_PER_CALL = 100;

/** Above the agent's 3.75 MB model image ceiling. */
const MAX_TOOL_IMAGE_BYTES = 5_000_000;

const TOOL_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const SHA256_HEX = /^[0-9a-f]{64}$/;

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

/** Images stay live for as long as attachments of the run's thread do. */
export const toolImageUrlsForRun = mutation({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		sha256s: v.array(v.string())
	},
	returns: v.array(
		v.union(
			v.object({ sha256: v.string(), url: v.string() }),
			v.object({ sha256: v.string(), uploadUrl: v.string() })
		)
	),
	handler: async (ctx, args) => {
		const run = await activeRunRecord(ctx, args);
		const sha256s = [...new Set(args.sha256s)];

		if (sha256s.length > MAX_TOOL_IMAGES_PER_CALL) {
			throw new Error(`At most ${MAX_TOOL_IMAGES_PER_CALL} images per call.`);
		}

		return await Promise.all(
			sha256s.map(async (sha256) => {
				requireSha256(sha256);
				const image = await liveToolImage(ctx, run, sha256);
				const url = image && (await ctx.storage.getUrl(image.storageId));

				return url ? { sha256, url } : { sha256, uploadUrl: await ctx.storage.generateUploadUrl() };
			})
		);
	}
});

export const registerToolImageForRun = mutation({
	args: {
		runId: v.id('runs'),
		executionSecret: v.string(),
		storageId: v.id('_storage'),
		sha256: v.string()
	},
	returns: v.string(),
	handler: async (ctx, args) => {
		const run = await activeRunRecord(ctx, args);
		requireSha256(args.sha256);

		if (
			(await imageUploadByStorageId(ctx, args.storageId)) ||
			(await registeredParseStorage(ctx, args.storageId))
		) {
			throw new Error('Tool images require a dedicated upload.');
		}

		const metadata = await ctx.db.system.get('_storage', args.storageId);

		if (!metadata) throw new Error('Uploaded image was not found.');
		const mediaType = metadata.contentType?.toLowerCase() ?? '';

		if (metadata.size > MAX_TOOL_IMAGE_BYTES || !TOOL_IMAGE_MEDIA_TYPES.has(mediaType)) {
			throw new Error('Tool images must be png, jpeg, gif, or webp up to 5 MB.');
		}

		// A concurrent upload of the same bytes won; keep its URL so prompt caches stay valid.
		const existing = await liveToolImage(ctx, run, args.sha256);
		const existingUrl = existing && (await ctx.storage.getUrl(existing.storageId));

		if (existingUrl) {
			await ctx.storage.delete(args.storageId);

			return existingUrl;
		}

		const url = await ctx.storage.getUrl(args.storageId);

		if (!url) throw new Error('Uploaded image is unavailable.');
		await ctx.db.insert('imageUploads', {
			userId: run.userId,
			storageId: args.storageId,
			name: `tool-image-${args.sha256.slice(0, 12)}`,
			mediaType,
			size: metadata.size,
			attached: true,
			threadId: run.threadId,
			sha256: args.sha256
		});

		return url;
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

async function activeRunRecord(
	ctx: MutationCtx,
	args: { runId: Id<'runs'>; executionSecret: string }
): Promise<Doc<'runs'>> {
	const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);

	if (isRunFinalStatus(run.status)) throw new Error('Run is no longer active.');

	return run;
}

function requireSha256(sha256: string): void {
	if (!SHA256_HEX.test(sha256)) throw new Error('Image hash must be a lowercase hex sha256.');
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
