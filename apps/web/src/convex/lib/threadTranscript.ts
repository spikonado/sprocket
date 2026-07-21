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

export function compareTranscriptMessages(
	left: ThreadTranscriptMessage,
	right: ThreadTranscriptMessage
): number {
	if (left.runStartedAt !== right.runStartedAt) {
		return left.runStartedAt - right.runStartedAt;
	}
	if (left._creationTime !== right._creationTime) {
		return left._creationTime - right._creationTime;
	}
	// Prompts precede responses within the same run.
	if (left.type !== right.type) {
		return left.type === 'prompt' ? -1 : 1;
	}
	return left._id.localeCompare(right._id);
}

async function hydrateMessageAttachments(
	ctx: MutationCtx | QueryCtx,
	message: Doc<'threadMessages'>
): Promise<ThreadTranscriptAttachment[]> {
	return (
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
}

async function toTranscriptMessage(
	ctx: MutationCtx | QueryCtx,
	message: Doc<'threadMessages'>,
	run: Doc<'runs'>
): Promise<ThreadTranscriptMessage> {
	return {
		...message,
		attachments: await hydrateMessageAttachments(ctx, message),
		runStatus: run.status,
		runStartedAt: run.startedAt,
		runCompletedAt: run.completedAt
	};
}

/** Hydrate messages for the supplied runs (prompt then response per run). */
export async function hydrateTranscriptMessages(
	ctx: MutationCtx | QueryCtx,
	runs: Doc<'runs'>[]
): Promise<ThreadTranscriptMessage[]> {
	const transcriptMessages: ThreadTranscriptMessage[] = [];

	for (const run of runs) {
		for (const messageId of [run.promptMessageId, run.responseMessageId]) {
			if (!messageId) {
				continue;
			}
			const message = await ctx.db.get(messageId);
			if (!message) {
				continue;
			}
			transcriptMessages.push(await toTranscriptMessage(ctx, message, run));
		}
	}

	return transcriptMessages;
}

/** Hydrate already-loaded threadMessages, resolving their runs (legacy pagination). */
export async function hydrateTranscriptMessagesFromDocs(
	ctx: MutationCtx | QueryCtx,
	messages: Doc<'threadMessages'>[]
): Promise<ThreadTranscriptMessage[]> {
	const runIds = [...new Set(messages.map((message) => message.runId))];
	const runsById = new Map<Id<'runs'>, Doc<'runs'>>();
	for (const run of await Promise.all(runIds.map((runId) => ctx.db.get(runId)))) {
		if (run) {
			runsById.set(run._id, run);
		}
	}

	const transcriptMessages: ThreadTranscriptMessage[] = [];
	for (const message of messages) {
		const run = runsById.get(message.runId);
		if (!run) {
			continue;
		}
		transcriptMessages.push(await toTranscriptMessage(ctx, message, run));
	}
	return transcriptMessages;
}

export async function buildThreadTranscript(
	ctx: MutationCtx | QueryCtx,
	threadId: Id<'threadRecords'>
): Promise<ThreadTranscriptMessage[]> {
	const runs = await ctx.db
		.query('runs')
		.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', threadId))
		.collect();
	return hydrateTranscriptMessages(ctx, runs);
}
