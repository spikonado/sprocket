import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { compareRunStartedAt } from '@convex/lib/runs';
import {
	appendTranscriptPart,
	attachmentMetaForUploads,
	getOrCreateTranscriptState,
	getTranscriptState,
	groupLegacyResponseIntoRecords,
	promptSourceKey
} from '@convex/lib/transcriptParts';

export async function ensureThreadTranscriptMigrated(
	ctx: MutationCtx,
	args: { threadId: Id<'threadRecords'>; userId: string }
): Promise<Doc<'threadTranscriptStates'>> {
	const state = await getOrCreateTranscriptState(ctx, args);
	if (state.migratedAt !== undefined) {
		return state;
	}
	await migrateLegacyThreadTranscript(ctx, args);
	const migrated = await getTranscriptState(ctx, args.threadId);
	if (!migrated) {
		throw new Error('Transcript state missing after migration.');
	}
	return migrated;
}

export async function migrateLegacyRunTranscript(
	ctx: MutationCtx,
	run: Doc<'runs'>
): Promise<number> {
	let inserted = 0;
	if (run.promptMessageId) {
		const prompt = await ctx.db.get('threadMessages', run.promptMessageId);
		if (prompt) {
			const result = await appendTranscriptPart(ctx, {
				threadId: run.threadId,
				userId: run.userId,
				sourceKey: promptSourceKey(run._id),
				kind: 'prompt',
				runId: run._id,
				prompt: {
					text: prompt.text,
					imageUploads: await attachmentMetaForUploads(ctx, prompt.imageUploadIds)
				}
			});
			if (result.inserted) inserted += 1;
		}
	}
	if (!run.responseMessageId || run.status !== 'completed') {
		return inserted;
	}
	const response = await ctx.db.get('threadMessages', run.responseMessageId);
	if (!response) {
		return inserted;
	}
	for (const record of groupLegacyResponseIntoRecords({
		runId: run._id,
		messageId: response._id,
		parts: response.parts,
		text: response.text
	})) {
		const result =
			record.kind === 'completion'
				? await appendTranscriptPart(ctx, {
						threadId: run.threadId,
						userId: run.userId,
						sourceKey: record.sourceKey,
						kind: 'completion',
						runId: run._id,
						completion: record.completion
					})
				: await appendTranscriptPart(ctx, {
						threadId: run.threadId,
						userId: run.userId,
						sourceKey: record.sourceKey,
						kind: 'tool',
						runId: run._id,
						tool: record.tool
					});
		if (result.inserted) inserted += 1;
	}
	return inserted;
}

export async function verifyThreadTranscriptNumbering(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	userId: string
): Promise<boolean> {
	const state = await getOrCreateTranscriptState(ctx, { threadId, userId });
	if (state.migratedAt !== undefined) {
		return true;
	}
	for (let number = 0; number < state.totalParts; number += 1) {
		const part = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_number', (query) =>
				query.eq('threadId', threadId).eq('number', number)
			)
			.unique();
		if (!part) {
			return false;
		}
	}
	await ctx.db.patch('threadTranscriptStates', state._id, { migratedAt: Date.now() });
	return true;
}

export async function migrateLegacyThreadTranscript(
	ctx: MutationCtx,
	args: { threadId: Id<'threadRecords'>; userId: string }
): Promise<number> {
	const state = await getOrCreateTranscriptState(ctx, args);
	if (state.migratedAt !== undefined) {
		return 0;
	}

	const runs = (
		await ctx.db
			.query('runs')
			.withIndex('by_threadId_startedAt', (query) => query.eq('threadId', args.threadId))
			.collect()
	).sort(compareRunStartedAt);

	let inserted = 0;
	for (const run of runs) {
		inserted += await migrateLegacyRunTranscript(ctx, run);
	}

	await verifyThreadTranscriptNumbering(ctx, args.threadId, args.userId);
	return inserted;
}
