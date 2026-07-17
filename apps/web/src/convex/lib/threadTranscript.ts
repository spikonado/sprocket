import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';

export type ThreadTranscriptAttachment = {
	imageUploadId: Id<'imageUploads'>;
	name: string;
	mediaType: string;
	size: number;
	url: string;
};

export type ThreadTranscriptMessage = Doc<'threadMessages'> & {
	attachments: ThreadTranscriptAttachment[];
	runStatus: Doc<'runs'>['status'];
	runStartedAt: number;
	runCompletedAt?: number;
};

export async function buildThreadTranscript(
	ctx: MutationCtx | QueryCtx,
	threadId: Id<'threadRecords'>
): Promise<ThreadTranscriptMessage[]> {
	const runs: Doc<'runs'>[] = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
		.collect();
	const transcriptMessages: ThreadTranscriptMessage[] = [];

	for (const run of runs) {
		for (const messageId of [run.promptMessageId, run.responseMessageId]) {
			if (!messageId) {
				continue;
			}
			const message: Doc<'threadMessages'> | null = await ctx.db.get(messageId);
			if (!message) {
				continue;
			}

			const attachments = (
				await Promise.all(
					(message.imageUploadIds ?? []).map(async (imageUploadId) => {
						const upload = await ctx.db.get(imageUploadId);
						if (
							!upload ||
							upload.userId !== message.userId ||
							!upload.messageIds.includes(message._id)
						) {
							return null;
						}
						const url = await ctx.storage.getUrl(upload.storageId);
						return url
							? {
									imageUploadId: upload._id,
									name: upload.name,
									mediaType: upload.mediaType,
									size: upload.size,
									url
								}
							: null;
					})
				)
			).filter((attachment) => attachment !== null);

			transcriptMessages.push({
				...message,
				attachments,
				runStatus: run.status,
				runStartedAt: run.startedAt,
				runCompletedAt: run.completedAt
			});
		}
	}

	return transcriptMessages;
}
