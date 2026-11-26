import type { Doc, Id } from '@convex/_generated/dataModel';
import { mutation, type MutationCtx } from '@convex/_generated/server';
import { ConvexError, v } from 'convex/values';
import { getExecutionRunRecord } from '@convex/lib/auth';
import { agentError } from '@convex/lib/agentErrors';
import { isRunFinalStatus } from '@convex/lib/validators';
import { imageUploadByStorageId } from '@convex/lib/imageUploads';

const MAX_TOOL_IMAGES_PER_CALL = 100;

const MAX_TOOL_IMAGE_BYTES = 5_000_000;

const TOOL_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const generateUploadUrl = mutation({
	args: {},
	returns: v.string(),
	handler: () => {
		throw new ConvexError('Update Sprocket to attach files.');
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

		if (await imageUploadByStorageId(ctx, args.storageId)) {
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

async function activeRunRecord(
	ctx: MutationCtx,
	args: { runId: Id<'runs'>; executionSecret: string }
): Promise<Doc<'runs'>> {
	const run = await getExecutionRunRecord(ctx, args.runId, args.executionSecret);

	if (isRunFinalStatus(run.status)) throw agentError('RUN_NO_LONGER_ACTIVE');

	return run;
}

function requireSha256(sha256: string): void {
	if (!SHA256_HEX.test(sha256)) throw new Error('Image hash must be a lowercase hex sha256.');
}

async function liveToolImage(
	ctx: MutationCtx,
	run: Doc<'runs'>,
	sha256: string
): Promise<Doc<'imageUploads'> | null> {
	return await ctx.db
		.query('imageUploads')
		.withIndex('by_threadId_and_sha256_and_storageDeletedAt', (query) =>
			query.eq('threadId', run.threadId).eq('sha256', sha256).eq('storageDeletedAt', undefined)
		)
		.first();
}
