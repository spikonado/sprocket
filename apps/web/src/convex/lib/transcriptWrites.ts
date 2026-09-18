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
import {
	writeCompletionSectionData,
	writeToolSectionData,
	type PersistedWork
} from '@convex/lib/transcriptSectionWrites';

type TranscriptToolJob = Pick<
	Doc<'executorJobs'>,
	| '_id'
	| '_creationTime'
	| 'hidden'
	| 'status'
	| 'callId'
	| 'kind'
	| 'result'
	| 'error'
	| 'completedAt'
	| 'toolInvocationId'
	| 'sectionKey'
	| 'sectionOrdinal'
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
		},
		work: { ranges: [] }
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
		work: PersistedWork;
		sections: { sectionKey: string; sectionOrdinal: number; closed: boolean }[];
		toolInvocations: { callId: string; toolInvocationId: string; sectionKey?: string }[];
	}
): Promise<Doc<'threadTranscriptParts'> | null> {
	if (args.items.length === 0) {
		return null;
	}
	let invocationIndex = 0;
	const toolInvocations = args.items.flatMap((item, index) => {
		if (item.type !== 'tool-call') return [];
		const invocation = args.toolInvocations[invocationIndex++];
		if (!invocation) throw new Error('Missing tool invocation assignment.');
		return [{ item: index, toolInvocationId: invocation.toolInvocationId }];
	});
	const work = { ...args.work, toolInvocations };
	const result = await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: completionSourceKey(args.runId, args.streamId),
		kind: 'completion',
		runId: args.runId,
		completion: { streamId: args.streamId, items: args.items },
		work
	});
	if (!result.inserted) return result.part;
	await writeCompletionSectionData(ctx, {
		part: result.part,
		work,
		sections: args.sections,
		representedCallIds: new Set(args.toolInvocations.map((invocation) => invocation.callId))
	});
	return result.part;
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
	if (!args.job.sectionKey || args.job.sectionOrdinal === undefined) {
		throw new Error('Visible tool job has no transcript section assignment.');
	}
	const result = await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: toolSourceKey(toolInvocationId, 'started'),
		kind: 'tool',
		runId: args.runId,
		tool: progressToolBody(args.job, { status: 'started' }),
		work: { ranges: [], sectionKey: args.job.sectionKey }
	});
	if (!result.inserted) return;
	await writeToolSectionData(ctx, {
		part: result.part,
		sectionKey: args.job.sectionKey,
		sectionOrdinal: args.job.sectionOrdinal,
		toolInvocationId,
		started: true,
		occurredAt: args.job._creationTime
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
	if (!args.job.sectionKey || args.job.sectionOrdinal === undefined) {
		throw new Error('Visible tool job has no transcript section assignment.');
	}
	const result = await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: toolSourceKey(toolInvocationId, 'finished'),
		kind: 'tool',
		runId: args.runId,
		tool: settledToolBody(args.job),
		work: { ranges: [], sectionKey: args.job.sectionKey }
	});
	if (!result.inserted) return;
	await writeToolSectionData(ctx, {
		part: result.part,
		sectionKey: args.job.sectionKey,
		sectionOrdinal: args.job.sectionOrdinal,
		toolInvocationId,
		started: false,
		occurredAt: args.job.completedAt
	});
}

export async function recordSettledToolTranscripts(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		userId: string;
		runId: Id<'runs'>;
		items: TranscriptCompletionItem[];
		toolInvocations: { callId: string; toolInvocationId: string }[];
	}
): Promise<void> {
	const callIds = args.items.flatMap((item) => (item.type === 'tool-call' ? [item.callId] : []));
	for (const [index, callId] of callIds.entries()) {
		const invocation = args.toolInvocations[index];
		if (!invocation || invocation.callId !== callId) {
			throw new Error('Missing tool invocation assignment.');
		}
		const job = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_and_toolInvocationId', (query) =>
				query.eq('runId', args.runId).eq('toolInvocationId', invocation.toolInvocationId)
			)
			.unique();
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
