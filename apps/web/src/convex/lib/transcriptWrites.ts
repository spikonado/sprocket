import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import { ensureThreadTranscriptMigrated } from '@convex/lib/transcriptMigrate';
import {
	appendTranscriptPart,
	attachmentMetaForUploads,
	completionSourceKey,
	promptSourceKey,
	toolSourceKey
} from '@convex/lib/transcriptParts';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';
import type { TranscriptCompletionItem, TranscriptToolBody } from '@convex/lib/validators';

export async function recordPromptTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
		text: string;
		imageUploadIds?: Id<'imageUploads'>[];
	}
): Promise<void> {
	await ensureThreadTranscriptMigrated(ctx, {
		threadId: args.threadId,
		userId: args.userId
	});
	await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: promptSourceKey(args.runId),
		kind: 'prompt',
		runId: args.runId,
		prompt: {
			text: args.text,
			imageUploads: await attachmentMetaForUploads(ctx, args.imageUploadIds)
		}
	});
}

export async function recordCompletionTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
		streamId: string;
		items: TranscriptCompletionItem[];
	}
): Promise<number | null> {
	if (args.items.length === 0) {
		return null;
	}
	await ensureThreadTranscriptMigrated(ctx, {
		threadId: args.threadId,
		userId: args.userId
	});
	const result = await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: completionSourceKey(args.runId, args.streamId),
		kind: 'completion',
		runId: args.runId,
		completion: { streamId: args.streamId, items: args.items }
	});
	return result.number;
}

export async function recordToolTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
		job: Pick<
			Doc<'executorJobs'>,
			'_id' | 'hidden' | 'status' | 'callId' | 'kind' | 'result' | 'error'
		>;
		allowWithoutMatchingCompletion?: boolean;
	}
): Promise<void> {
	if (args.job.hidden) {
		return;
	}
	if (!isSettledExecutorJobStatus(args.job.status)) {
		return;
	}
	if (
		args.job.callId &&
		!args.allowWithoutMatchingCompletion &&
		!(await runCompletionContainsToolCall(ctx, args.threadId, args.runId, args.job.callId))
	) {
		return;
	}
	const status: TranscriptToolBody['status'] = args.job.status;
	const output =
		args.job.status === 'completed' && args.job.result !== undefined
			? args.job.result
			: {
					error:
						args.job.error ??
						(args.job.status === 'cancelled'
							? 'Executor job cancelled before completion.'
							: 'Executor job failed.'),
					status
				};
	await ensureThreadTranscriptMigrated(ctx, {
		threadId: args.threadId,
		userId: args.userId
	});
	await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: toolSourceKey(args.job._id),
		kind: 'tool',
		runId: args.runId,
		tool: {
			jobId: args.job._id,
			callId: args.job.callId ?? `executor-job:${args.job._id}`,
			name: args.job.kind,
			output,
			status
		}
	});
}

export async function recordSettledToolTranscripts(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
	}
): Promise<void> {
	const jobs = await ctx.db
		.query('executorJobs')
		.withIndex('by_runId_sequence', (query) => query.eq('runId', args.runId))
		.collect();
	for (const job of jobs) {
		await recordToolTranscript(ctx, {
			threadId: args.threadId,
			userId: args.userId,
			runId: args.runId,
			job
		});
	}
}

async function runCompletionContainsToolCall(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	runId: Id<'runs'>,
	callId: string
): Promise<boolean> {
	const parts = await ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_and_runId_and_number', (query) =>
			query.eq('threadId', threadId).eq('runId', runId)
		)
		.collect();
	return parts.some(
		(part) =>
			part.kind === 'completion' &&
			part.completion?.items.some((item) => item.type === 'tool-call' && item.callId === callId)
	);
}
