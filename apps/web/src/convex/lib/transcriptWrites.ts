import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import {
	appendTranscriptPart,
	attachmentMetaForUploads,
	completionSourceKey,
	getOrCreateTranscriptState,
	promptSourceKey,
	toolSourceKey
} from '@convex/lib/transcriptParts';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';
import type { TranscriptCompletionItem, TranscriptToolBody } from '@convex/lib/validators';

const SETTLED_TOOL_TRANSCRIPTS_PAGE_SIZE = 32;

// Leave enough read budget for the caller's own writes after the sweep.
const SETTLED_TOOL_READ_RESERVE_DOCS = 64;
const SETTLED_TOOL_READ_RESERVE_BYTES = 512 * 1024;

function isReadBudgetError(error: Error): boolean {
	return /too many .{0,40}read/i.test(error.message);
}

async function transactionNearReadLimit(ctx: MutationCtx): Promise<boolean> {
	try {
		const metrics = await ctx.meta.getTransactionMetrics();
		return (
			metrics.documentsRead.remaining < SETTLED_TOOL_READ_RESERVE_DOCS ||
			metrics.bytesRead.remaining < SETTLED_TOOL_READ_RESERVE_BYTES
		);
	} catch {
		return false;
	}
}

export async function recordPromptTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
		text: string;
		imageUploadIds?: Id<'imageUploads'>[];
	}
): Promise<Doc<'threadTranscriptParts'>> {
	const result = await appendTranscriptPart(ctx, {
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
	return result.part;
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
	const result = await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: completionSourceKey(args.runId, args.streamId),
		kind: 'completion',
		runId: args.runId,
		completion: { streamId: args.streamId, items: args.items }
	});
	return result.part.number;
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
	// stay cheap: read parts and jobs in bounded chunks, skip jobs whose part
	// already exists, and insert the rest from one in-memory number counter
	// instead of per-job lookups. If the run's history is large enough to
	// exhaust the read budget, bail out — terminal cleanup records any
	// deferred jobs when the run finishes.
	const state = await getOrCreateTranscriptState(ctx, {
		threadId: args.threadId,
		userId: args.userId
	});
	try {
		await recordSettledToolTranscriptsWithinBudget(ctx, args, state._id, state.totalParts);
	} catch (error) {
		if (error instanceof Error && isReadBudgetError(error)) {
			return;
		}
		throw error;
	}
}

async function recordSettledToolTranscriptsWithinBudget(
	ctx: MutationCtx,
	args: { threadId: Id<'threadRecords'>; userId: string; runId: Id<'runs'> },
	stateId: Id<'threadTranscriptStates'>,
	initialNumber: number
): Promise<void> {
	let nextNumber = initialNumber;

	const recordedSourceKeys = new Set<string>();
	const completedCallIds = new Set<string>();
	// Parts are numbered contiguously per thread, so number is a stable cursor.
	// (.paginate would be cleaner, but Convex allows only one paginated query
	// per function execution.)
	let afterNumber = -1;
	for (;;) {
		if (await transactionNearReadLimit(ctx)) {
			return;
		}
		const parts = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_runId_and_number', (query) =>
				query.eq('threadId', args.threadId).eq('runId', args.runId).gt('number', afterNumber)
			)
			.take(SETTLED_TOOL_TRANSCRIPTS_PAGE_SIZE);
		for (const part of parts) {
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
		if (parts.length < SETTLED_TOOL_TRANSCRIPTS_PAGE_SIZE) {
			break;
		}
		afterNumber = parts.at(-1)?.number ?? afterNumber;
	}

	let afterSequence = -1;
	for (;;) {
		if (await transactionNearReadLimit(ctx)) {
			break;
		}
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

	if (nextNumber !== initialNumber) {
		await ctx.db.patch('threadTranscriptStates', stateId, { totalParts: nextNumber });
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
