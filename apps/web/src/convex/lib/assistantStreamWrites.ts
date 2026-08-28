import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { joinAssistantTextParts } from '@convex/lib/assistantParts';
import { appendThreadMessage, getThreadMessage } from '@convex/lib/threadMessages';

export async function getCompletionStreamState(
	ctx: MutationCtx | QueryCtx,
	run: Doc<'runs'>
): Promise<Doc<'completionStreamStates'>> {
	if (!run.completionStreamStateId) {
		throw new Error('Run does not contain completion stream state.');
	}
	const state = await ctx.db.get('completionStreamStates', run.completionStreamStateId);
	if (!state || state.runId !== run._id || state.userId !== run.userId) {
		throw new Error('Completion stream state is invalid.');
	}
	return state;
}

export async function beginAssistantMessageForRun(
	ctx: MutationCtx,
	run: Doc<'runs'>
): Promise<void> {
	if (run.responseMessageId) return;
	const messageId = await appendThreadMessage(ctx, {
		threadId: run.threadId,
		runId: run._id,
		userId: run.userId,
		type: 'response',
		text: ''
	});
	await ctx.db.patch('runs', run._id, { responseMessageId: messageId });
}

export async function registerCompletionAttemptForRun(
	ctx: MutationCtx,
	run: Doc<'runs'>,
	attemptSeq: number,
	supersededStreamIds: string[]
): Promise<void> {
	await ctx.db.patch('runs', run._id, { completionAttemptSeq: attemptSeq });
	if (supersededStreamIds.length === 0 || !run.responseMessageId) return;
	const superseded = new Set(supersededStreamIds);
	const message = await getThreadMessage(ctx, run.responseMessageId);
	const parts = message.parts.filter(
		(part) => !('turnId' in part && part.turnId && superseded.has(part.turnId))
	);
	if (parts.length !== message.parts.length) {
		await ctx.db.patch('threadMessages', run.responseMessageId, {
			text: joinAssistantTextParts(parts),
			parts
		});
	}
}
