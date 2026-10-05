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
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from '@convex/lib/json';
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
	| 'status'
	| 'callId'
	| 'kind'
	| 'payload'
	| 'result'
	| 'error'
	| 'completedAt'
	| 'toolInvocationId'
	| 'sectionKey'
	| 'sectionOrdinal'
>;

export function isCommandToolName(name: string): boolean {
	return (
		name === 'exec_cmd' ||
		name === 'exec_command' ||
		name === 'control_cmd' ||
		name === 'control_command' ||
		name === 'poll_cmd' ||
		name === 'poll_command' ||
		name === 'write_stdin'
	);
}

export function commandToolDisplayInput(name: string, input: JsonValue): JsonObject | undefined {
	if (!isCommandToolName(name) || !isJsonObject(input)) return undefined;

	const display: JsonObject = {};

	for (const key of ['cmd', 'workdir']) {
		const value = input[key];

		if (isJsonString(value)) {
			display[key] = value.length > 8192 ? `${value.slice(0, 8192)}…` : value;
		}
	}

	if (isJsonString(input.sessionId) && input.sessionId.length <= 128) {
		display.sessionId = input.sessionId;
	}

	if (input.action === 'write' || input.action === 'terminate') display.action = input.action;

	return display;
}

async function appendToolTranscriptPart(
	ctx: MutationCtx,
	args: Parameters<typeof appendTranscriptPart>[1]
) {
	if (args.tool?.input !== undefined) {
		const existing = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_sourceKey', (q) =>
				q.eq('threadId', args.threadId).eq('sourceKey', args.sourceKey)
			)
			.unique();

		if (existing?.kind === 'tool' && existing.tool && existing.tool.input === undefined) {
			await ctx.db.patch('threadTranscriptParts', existing._id, {
				tool: { ...existing.tool, input: args.tool.input }
			});
		}
	}

	return await appendTranscriptPart(ctx, args);
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
	const toolInvocationId = toolInvocationIdForJob(args.job);

	const result = await appendToolTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: toolSourceKey(toolInvocationId, 'started'),
		kind: 'tool',
		runId: args.runId,
		tool: progressToolBody(args.job, { status: 'started' }),
		work: args.job.sectionKey ? { ranges: [], sectionKey: args.job.sectionKey } : { ranges: [] }
	});

	if (!args.job.sectionKey || args.job.sectionOrdinal === undefined) return;
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
	if (!isSettledExecutorJobStatus(args.job.status)) {
		return;
	}

	const toolInvocationId = toolInvocationIdForJob(args.job);

	const result = await appendToolTranscriptPart(ctx, {
		threadId: args.threadId,
		userId: args.userId,
		sourceKey: toolSourceKey(toolInvocationId, 'finished'),
		kind: 'tool',
		runId: args.runId,
		tool: settledToolBody(args.job),
		work: args.job.sectionKey ? { ranges: [], sectionKey: args.job.sectionKey } : { ranges: [] }
	});

	if (!args.job.sectionKey || args.job.sectionOrdinal === undefined) return;
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
		toolInvocations?: { callId: string; toolInvocationId: string }[];
	}
): Promise<void> {
	const callIds = args.items.flatMap((item) => (item.type === 'tool-call' ? [item.callId] : []));

	for (const [index, callId] of callIds.entries()) {
		const invocation = args.toolInvocations?.[index];

		const job = invocation
			? await ctx.db
					.query('executorJobs')
					.withIndex('by_runId_and_toolInvocationId', (query) =>
						query.eq('runId', args.runId).eq('toolInvocationId', invocation.toolInvocationId)
					)
					.unique()
			: await ctx.db
					.query('executorJobs')
					.withIndex('by_runId_and_callId', (query) =>
						query.eq('runId', args.runId).eq('callId', callId)
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

	const input = commandToolDisplayInput(job.kind, job.payload);

	if (input !== undefined) body.input = input;

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
