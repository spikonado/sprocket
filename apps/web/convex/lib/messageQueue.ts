import { v } from 'convex/values';
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { vCompletionProvider, vReasoningEffort } from './validators';
import { executionSecretHash } from './auth';

export const MESSAGE_QUEUE_LIMIT = 256;

export const MESSAGE_QUEUE_LEASE_MS = 120_000;

export const queuedMessageFields = {
	userId: v.string(),
	machineId: v.string(),
	threadId: v.id('threadRecords'),
	submissionId: v.string(),
	executionSecret: v.string(),
	workspacePath: v.string(),
	prompt: v.string(),
	storageIds: v.array(v.id('_storage')),
	attachmentNames: v.array(v.string()),
	selectedModel: v.string(),
	completionProvider: vCompletionProvider,
	reasoningEffort: vReasoningEffort,
	fastMode: v.boolean(),
	status: v.union(v.literal('queued'), v.literal('sending'), v.literal('failed')),
	claimId: v.optional(v.string()),
	claimExpiresAt: v.optional(v.number()),
	error: v.optional(v.string())
};

export async function isQueuedAttachment(ctx: QueryCtx | MutationCtx, storageId: Id<'_storage'>) {
	return (
		(await ctx.db
			.query('queuedMessageAttachments')
			.withIndex('by_storageId', (q) => q.eq('storageId', storageId))
			.first()) !== null
	);
}

export async function deleteQueuedMessage(ctx: MutationCtx, message: Doc<'queuedMessages'>) {
	const refs = await ctx.db
		.query('queuedMessageAttachments')
		.withIndex('by_messageId', (q) => q.eq('messageId', message._id))
		.collect();

	for (const ref of refs) await ctx.db.delete('queuedMessageAttachments', ref._id);
	await ctx.db.delete('queuedMessages', message._id);
}

export async function queuedSubmission(
	ctx: QueryCtx | MutationCtx,
	message: Doc<'queuedMessages'>
) {
	return await ctx.db
		.query('runs')
		.withIndex('by_userId_submissionId', (q) =>
			q.eq('userId', message.userId).eq('submissionId', message.submissionId)
		)
		.unique();
}

export async function isDurableQueuedRun(ctx: MutationCtx, run: Doc<'runs'>) {
	if (run.status !== 'queued' || run.cancellationRequestedAt !== undefined) return false;

	const message = await ctx.db
		.query('queuedMessages')
		.withIndex('by_userId_submissionId', (q) =>
			q.eq('userId', run.userId).eq('submissionId', run.submissionId)
		)
		.unique();

	return (
		message !== null &&
		message.threadId === run.threadId &&
		message.machineId === run.machineId &&
		(await executionSecretHash(message.executionSecret)) === run.executionSecretHash
	);
}
