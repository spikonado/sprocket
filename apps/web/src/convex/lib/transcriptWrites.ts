import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import {
	appendTranscriptPart,
	attachmentMetaForUploads,
	completionSourceKey,
	promptSourceKey,
	toolInvocationIdForJob,
	toolSourceKey
} from '@convex/lib/transcriptParts';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';
import type { TranscriptCompletionItem, TranscriptToolBody } from '@convex/lib/validators';

type TranscriptToolJob = Pick<
	Doc<'executorJobs'>,
	'_id' | 'hidden' | 'status' | 'callId' | 'kind' | 'result' | 'error' | 'toolInvocationId'
>;

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

export async function recordStartedToolTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
		job: TranscriptToolJob;
	}
): Promise<void> {
	if (args.job.hidden) {
		return;
	}
	const toolInvocationId = toolInvocationIdForJob(args.job);
	await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: toolSourceKey(toolInvocationId, 'started'),
		kind: 'tool',
		runId: args.runId,
		tool: progressToolBody(args.job, { status: 'started' })
	});
}

export async function recordToolTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
		job: TranscriptToolJob;
	}
): Promise<void> {
	if (args.job.hidden) {
		return;
	}
	if (!isSettledExecutorJobStatus(args.job.status)) {
		return;
	}
	const toolInvocationId = toolInvocationIdForJob(args.job);
	await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: toolSourceKey(toolInvocationId, 'finished'),
		kind: 'tool',
		runId: args.runId,
		tool: settledToolBody(args.job)
	});
}

export async function recordSettledToolTranscripts(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
		items: TranscriptCompletionItem[];
	}
): Promise<void> {
	const callIds = new Set(
		args.items.flatMap((item) => (item.type === 'tool-call' ? [item.callId] : []))
	);
	for (const callId of callIds) {
		const job = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_and_callId_and_hidden', (query) =>
				query.eq('runId', args.runId).eq('callId', callId).eq('hidden', false)
			)
			.order('desc')
			.first();
		if (job) {
			await recordToolTranscript(ctx, {
				threadId: args.threadId,
				userId: args.userId,
				runId: args.runId,
				job
			});
		}
	}
}

function progressToolBody(
	job: TranscriptToolJob,
	args: { status: TranscriptToolBody['status']; output?: TranscriptToolBody['output'] }
): TranscriptToolBody {
	const body: TranscriptToolBody = {
		toolInvocationId: toolInvocationIdForJob(job),
		callId: job.callId ?? `executor-job:${job._id}`,
		name: job.kind,
		status: args.status
	};
	if (args.output !== undefined) {
		body.output = args.output;
	}
	return body;
}

function settledToolBody(job: TranscriptToolJob): TranscriptToolBody {
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
	return progressToolBody(job, { status, output });
}
