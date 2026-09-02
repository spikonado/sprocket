import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { ConvexError } from 'convex/values';
import type { ThreadMessageType } from '@convex/lib/validators';
import { getOwnedThreadRecord } from './access';
import { bumpThreadSnapshotForRecord } from './threadSnapshots';

export async function getThreadMessage(
	ctx: MutationCtx | QueryCtx,
	messageId: Id<'threadMessages'>
): Promise<Doc<'threadMessages'>> {
	const message = await ctx.db.get('threadMessages', messageId);
	if (!message) {
		throw new ConvexError('Message not found.');
	}
	return message;
}

export async function appendThreadMessage(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		userId: string;
		type: ThreadMessageType;
		text: string;
		imageUploadIds?: Id<'imageUploads'>[];
		parts?: Doc<'threadMessages'>['parts'];
	}
): Promise<Id<'threadMessages'>> {
	const threadRecord: Doc<'threadRecords'> = await getOwnedThreadRecord(
		ctx.db,
		args.userId,
		args.threadId
	);

	const messageId: Id<'threadMessages'> = await ctx.db.insert('threadMessages', {
		threadId: args.threadId,
		runId: args.runId,
		userId: args.userId,
		type: args.type,
		text: args.text,
		imageUploadIds: args.imageUploadIds,
		parts: args.parts ?? []
	});
	await ctx.db.patch('threadRecords', threadRecord._id, {
		lastMessageAt: Date.now()
	});
	await bumpThreadSnapshotForRecord(ctx, threadRecord);

	return messageId;
}
