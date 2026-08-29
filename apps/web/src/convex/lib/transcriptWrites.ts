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

const SETTLED_TOOL_TRANSCRIPTS_PAGE_SIZE = 32;

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
		tool: settledToolBody(args.job)
	});
}

async function runCompletionContainsToolCall(
	ctx: MutationCtx,
	threadId: Id<'threadRecords'>,
	runId: Id<'runs'>,
	callId: string
): Promise<boolean> {
	const parts = ctx.db
		.query('threadTranscriptParts')
		.withIndex('by_threadId_and_runId_and_number', (query) =>
			query.eq('threadId', threadId).eq('runId', runId)
		);
	for await (const part of parts) {
		if (
			part.kind === 'completion' &&
			part.completion?.items.some((item) => item.type === 'tool-call' && item.callId === callId)
		) {
			return true;
		}
	}
	return false;
}

export async function recordSettledToolTranscripts(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
	}
): Promise<void> {
	// finalizeCompletionCall runs this after every completion, so the scan must
	// stay roughly constant in the run's history: page jobs and parts, skip
	// jobs whose part already exists, and insert the rest from one in-memory
	// number counter instead of per-job lookups.
	const state = await ensureThreadTranscriptMigrated(ctx, {
		threadId: args.threadId,
		userId: args.userId
	});
	let nextNumber = state.totalParts;

	const recordedSourceKeys = new Set<string>();
	const completedCallIds = new Set<string>();
	let partsCursor: string | null = null;
	for (;;) {
		const page = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_runId_and_number', (query) =>
				query.eq('threadId', args.threadId).eq('runId', args.runId)
			)
			.paginate({ numItems: SETTLED_TOOL_TRANSCRIPTS_PAGE_SIZE, cursor: partsCursor });
		for (const part of page.page) {
			recordedSourceKeys.add(part.sourceKey);
			if (part.kind !== 'completion') {
				continue;
			}
			for (const item of part.completion?.items ?? []) {
				if (item.type === 'tool-call') {
					completedCallIds.add(item.callId);
				}
			}
		}
		if (page.isDone) {
			break;
		}
		partsCursor = page.continueCursor;
	}

	let afterSequence = -1;
	for (;;) {
		const jobs = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_hidden_sequence', (query) =>
				query.eq('runId', args.runId).eq('hidden', false).gt('sequence', afterSequence)
			)
			.take(SETTLED_TOOL_TRANSCRIPTS_PAGE_SIZE);
		for (const job of jobs) {
			if (!isSettledExecutorJobStatus(job.status)) {
				continue;
			}
			if (job.callId && !completedCallIds.has(job.callId)) {
				continue;
			}
			const sourceKey = toolSourceKey(job._id);
			if (recordedSourceKeys.has(sourceKey)) {
				continue;
			}
			await ctx.db.insert('threadTranscriptParts', {
				threadId: args.threadId,
				userId: args.userId,
				number: nextNumber,
				sourceKey,
				kind: 'tool',
				runId: args.runId,
				tool: settledToolBody(job)
			});
			recordedSourceKeys.add(sourceKey);
			nextNumber += 1;
		}
		if (jobs.length < SETTLED_TOOL_TRANSCRIPTS_PAGE_SIZE) {
			break;
		}
		afterSequence = jobs.at(-1)?.sequence ?? afterSequence;
	}

	if (nextNumber !== state.totalParts) {
		await ctx.db.patch('threadTranscriptStates', state._id, { totalParts: nextNumber });
	}
}

function settledToolBody(
	job: Pick<Doc<'executorJobs'>, '_id' | 'status' | 'callId' | 'kind' | 'result' | 'error'>
): TranscriptToolBody {
	if (!isSettledExecutorJobStatus(job.status)) {
		throw new Error('settledToolBody requires a settled executor job.');
	}
	const status: TranscriptToolBody['status'] = job.status;
	const output =
		job.status === 'completed' && job.result !== undefined
			? job.result
			: {
					error:
						job.error ??
						(job.status === 'cancelled'
							? 'Executor job cancelled before completion.'
							: 'Executor job failed.'),
					status
				};
	return {
		jobId: job._id,
		callId: job.callId ?? `executor-job:${job._id}`,
		name: job.kind,
		output,
		status
	};
}
