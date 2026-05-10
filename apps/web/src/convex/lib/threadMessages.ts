import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { ConvexError } from 'convex/values';
import {
	isThreadMessageFinalStatus,
	type ThreadMessageRole,
	type ThreadMessageStatus
} from '@convex/lib/validators';

export type AppendThreadMessageArgs = {
	threadId: Id<'threadRecords'>;
	runId: Id<'runs'>;
	role: ThreadMessageRole;
	status: ThreadMessageStatus;
	text: string;
	agentName?: string;
};

export async function listThreadMessages(
	ctx: MutationCtx | QueryCtx,
	threadId: Id<'threadRecords'>
): Promise<Doc<'threadMessages'>[]> {
	return await ctx.db
		.query('threadMessages')
		.withIndex('by_threadId_order', (query) => query.eq('threadId', threadId))
		.collect();
}

export async function getThreadMessage(
	ctx: MutationCtx | QueryCtx,
	messageId: Id<'threadMessages'>
): Promise<Doc<'threadMessages'>> {
	const message = await ctx.db.get(messageId);
	if (!message) {
		throw new ConvexError('Message not found.');
	}
	return message;
}

export async function appendThreadMessage(
	ctx: MutationCtx,
	args: AppendThreadMessageArgs
): Promise<{ messageId: Id<'threadMessages'>; order: number }> {
	const threadRecord = await ctx.db.get(args.threadId);
	if (!threadRecord) {
		throw new ConvexError('Thread not found.');
	}

	const order = threadRecord.nextMessageOrder ?? 0;

	const messageId: Id<'threadMessages'> = await ctx.db.insert('threadMessages', {
		threadId: args.threadId,
		runId: args.runId,
		role: args.role,
		status: args.status,
		text: args.text,
		order,
		stepOrder: 0,
		agentName: args.agentName,
		createdAt: Date.now(),
		completedAt: isThreadMessageFinalStatus(args.status) ? Date.now() : undefined
	});
	await ctx.db.patch(threadRecord._id, {
		nextMessageOrder: order + 1,
		lastMessageAt: Date.now()
	});

	return {
		messageId,
		order
	};
}
