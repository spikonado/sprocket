import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { isRunFinalStatus, type vRunStatus } from '@convex/lib/validators';
import type { Infer } from 'convex/values';

export const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
// Each thread/run document can approach 1 MiB. Keep every transaction below
// Convex's 16 MiB read limit even when shared threads have large summaries.
export const ATTACHMENT_CLEANUP_UPLOAD_BATCH = 1;
export const ATTACHMENT_CLEANUP_REF_BATCH = 4;

export type AttachmentRetentionDecision = 'retain' | 'delete' | 'wait';

export type ExpireUploadResult = {
	deleted: number;
	continueFromThreadId?: Id<'threadRecords'>;
	activityFenceAt?: number;
};

export function isActiveRunStatus(status: Infer<typeof vRunStatus> | undefined): boolean {
	return status !== undefined && !isRunFinalStatus(status);
}

export function shouldRetainAttachedStorage(args: {
	now: number;
	updatedAt: number | undefined;
	threadStatus: Infer<typeof vRunStatus> | undefined;
	latestRunStatus: Infer<typeof vRunStatus> | undefined;
}): AttachmentRetentionDecision {
	if (isActiveRunStatus(args.threadStatus) || isActiveRunStatus(args.latestRunStatus)) {
		return 'retain';
	}
	if (args.updatedAt === undefined) return 'wait';
	if (args.now - args.updatedAt <= ATTACHMENT_RETENTION_MS) return 'retain';
	return 'delete';
}

export async function ensureThreadAttachmentRefs(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	imageUploadIds: Id<'imageUploads'>[]
): Promise<void> {
	for (const imageUploadId of imageUploadIds) {
		const existing = await ctx.db
			.query('threadAttachmentRefs')
			.withIndex('by_threadId_and_imageUploadId', (query) =>
				query.eq('threadId', threadId).eq('imageUploadId', imageUploadId)
			)
			.first();
		if (existing) continue;
		const upload = await ctx.db.get('imageUploads', imageUploadId);
		if (!upload) continue;
		await ctx.db.insert('threadAttachmentRefs', { threadId, imageUploadId });
	}
}

export async function threadAttachmentRetentionDecision(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'threadRecords'>,
	now: number
): Promise<{ decision: AttachmentRetentionDecision; thread: Doc<'threadRecords'> | null }> {
	const thread = await ctx.db.get('threadRecords', threadId);
	if (!thread) return { decision: 'delete', thread: null };
	const latestRun = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
		.order('desc')
		.first();
	return {
		decision: shouldRetainAttachedStorage({
			now,
			updatedAt: thread.updatedAt,
			threadStatus: thread.status,
			latestRunStatus: latestRun?.status
		}),
		thread
	};
}

export function lastActivityAt(args: {
	lastMessageAt: number;
	createdAt: number;
	latestPartCreatedAt?: number;
	latestRunActivityAt?: number;
}): number {
	return Math.max(
		args.lastMessageAt,
		args.createdAt,
		args.latestPartCreatedAt ?? 0,
		args.latestRunActivityAt ?? 0
	);
}

export async function lastThreadActivityAt(
	ctx: MutationCtx | QueryCtx,
	thread: Doc<'threadRecords'>
): Promise<number> {
	const [latestPart, latestRun] = await Promise.all([
		ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_number', (query) => query.eq('threadId', thread._id))
			.order('desc')
			.first(),
		ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', thread._id))
			.order('desc')
			.first()
	]);
	return lastActivityAt({
		lastMessageAt: thread.lastMessageAt,
		createdAt: thread._creationTime,
		latestPartCreatedAt: latestPart?._creationTime,
		latestRunActivityAt: latestRun?.completedAt ?? latestRun?.startedAt
	});
}

export async function expireUploadIfInactive(
	ctx: MutationCtx,
	upload: Doc<'imageUploads'>,
	now: number,
	args: {
		exclusiveThreadId?: Id<'threadRecords'>;
		activityFenceAt?: number;
	} = {}
): Promise<ExpireUploadResult> {
	if (!upload.attached || upload.storageDeletedAt !== undefined) {
		return { deleted: 0 };
	}
	if (upload.threadRefsMigratedAt === undefined) {
		return { deleted: 0 };
	}
	if (args.exclusiveThreadId !== undefined && args.activityFenceAt === undefined) {
		return { deleted: 0 };
	}

	const refs = await ctx.db
		.query('threadAttachmentRefs')
		.withIndex('by_imageUploadId_and_threadId', (query) => {
			const forUpload = query.eq('imageUploadId', upload._id);
			return args.exclusiveThreadId === undefined
				? forUpload
				: forUpload.gt('threadId', args.exclusiveThreadId);
		})
		.take(ATTACHMENT_CLEANUP_REF_BATCH);

	if (refs.length === 0) {
		if (args.exclusiveThreadId === undefined) {
			return { deleted: 0 };
		}
		return await finishExpiredUpload(ctx, upload, now, args);
	}

	for (const ref of refs) {
		const { decision } = await threadAttachmentRetentionDecision(ctx, ref.threadId, now);
		if (decision !== 'delete') {
			return { deleted: 0 };
		}
	}

	if (refs.length === ATTACHMENT_CLEANUP_REF_BATCH) {
		const lastRef = refs.at(-1);
		if (!lastRef) return { deleted: 0 };
		return {
			deleted: 0,
			continueFromThreadId: lastRef.threadId,
			activityFenceAt: args.activityFenceAt ?? now
		};
	}

	return await finishExpiredUpload(ctx, upload, now, args);
}

async function finishExpiredUpload(
	ctx: MutationCtx,
	upload: Doc<'imageUploads'>,
	now: number,
	args: {
		exclusiveThreadId?: Id<'threadRecords'>;
		activityFenceAt?: number;
	}
): Promise<ExpireUploadResult> {
	// Earlier pages are no longer in this transaction's read set. Include equal
	// timestamps so an update in the scan's first millisecond also prevents deletion.
	if (args.activityFenceAt !== undefined) {
		const updated = await ctx.db
			.query('threadRecords')
			.withIndex('by_userId_and_updatedAt', (q) =>
				q.eq('userId', upload.userId).gte('updatedAt', args.activityFenceAt!)
			)
			.first();
		if (updated) return { deleted: 0 };
	}
	const metadata = await ctx.db.system.get('_storage', upload.storageId);
	if (metadata) {
		await ctx.storage.delete(upload.storageId);
	}
	await ctx.db.patch('imageUploads', upload._id, { storageDeletedAt: now });
	return { deleted: 1 };
}
