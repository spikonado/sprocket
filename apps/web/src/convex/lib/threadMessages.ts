import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { ConvexError } from 'convex/values';
import type { WithoutSystemFields } from 'convex/server';
import { getThreadRecordByThreadId } from '@convex/lib/access';
import type { ThreadMessageRole, ThreadMessageStatus } from '@convex/lib/validators';

export type AppendThreadMessageArgs = {
	threadId: string;
	runId?: Id<'runs'>;
	role: ThreadMessageRole;
	status: ThreadMessageStatus;
	text: string;
	agentName?: string;
};

export async function listThreadMessages(
	ctx: MutationCtx | QueryCtx,
	threadId: string
): Promise<Doc<'threadMessage'>[]> {
	return await ctx.db
		.query('threadMessage')
		.withIndex('by_threadId_order', (query) => query.eq('threadId', threadId))
		.collect();
}

export async function getThreadMessage(
	ctx: MutationCtx | QueryCtx,
	messageId: Id<'threadMessage'>
): Promise<Doc<'threadMessage'>> {
	const message = await ctx.db.get(messageId);
	if (!message) {
		throw new ConvexError('Message not found.');
	}
	return message;
}

function buildThreadMessageDoc(
	args: AppendThreadMessageArgs,
	order: number,
	now: number
): WithoutSystemFields<Doc<'threadMessage'>> {
	const doc: WithoutSystemFields<Doc<'threadMessage'>> = {
		threadId: args.threadId,
		role: args.role,
		status: args.status,
		text: args.text,
		order,
		stepOrder: 0,
		createdAt: now
	};
	if (args.runId !== undefined) {
		doc.runId = args.runId;
	}
	if (args.agentName !== undefined) {
		doc.agentName = args.agentName;
	}
	if (args.status === 'success' || args.status === 'failed') {
		doc.completedAt = now;
	}
	return doc;
}

export async function appendThreadMessage(
	ctx: MutationCtx,
	args: AppendThreadMessageArgs
): Promise<{ messageId: Id<'threadMessage'>; order: number }> {
	const threadRecord = await getThreadRecordByThreadId(ctx.db, args.threadId);
	if (!threadRecord) {
		throw new ConvexError('Thread not found.');
	}

	const order = threadRecord.nextMessageOrder ?? 0;
	const now = Date.now();
	const messageId = await ctx.db.insert('threadMessage', buildThreadMessageDoc(args, order, now));

	await ctx.db.patch(threadRecord._id, {
		nextMessageOrder: order + 1,
		lastMessageAt: now,
		lastMessagePreview: args.text.trim().slice(0, 160)
	});

	return {
		messageId,
		order
	};
}
