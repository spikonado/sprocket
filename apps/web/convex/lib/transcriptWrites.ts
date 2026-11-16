import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx } from '@convex/_generated/server';
import {
	appendTranscriptPart,
	completionSourceKey,
	hiddenPromptSourceKey,
	promptSourceKey,
	toolSourceKey
} from '@convex/lib/transcriptParts';
import { isSettledExecutorJobStatus } from '@convex/lib/runs';
import { isCommandToolKind } from '@convex/lib/commandToolKinds';
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from '@convex/lib/json';
import type {
	HiddenPrompt,
	TranscriptCompletionItem,
	TranscriptPromptBody,
	TranscriptToolBody
} from '@convex/lib/validators';

type PersistedWork = Doc<'threadTranscriptParts'>['work'];

type TranscriptToolJob = Pick<
	Doc<'executorJobs'>,
	| '_id'
	| 'status'
	| 'callId'
	| 'kind'
	| 'payload'
	| 'result'
	| 'error'
	| 'toolInvocationId'
	| 'sectionKey'
>;

export function commandToolDisplayInput(name: string, input: JsonValue): JsonObject | undefined {
	if (!isCommandToolKind(name) || !isJsonObject(input)) return undefined;

	const display: JsonObject = {};

	for (const key of ['cmd', 'workdir']) {
		const value = input[key];

		if (isJsonString(value)) {
			display[key] =
				value.length > 8192 ? `${value.slice(0, 8192).replace(/[\uD800-\uDBFF]$/u, '')}…` : value;
		}
	}

	if (isJsonString(input.sessionId) && input.sessionId.length <= 128) {
		display.sessionId = input.sessionId;
	}

	if (input.action === 'write' || input.action === 'terminate') display.action = input.action;

	return display;
}

export async function recordPromptTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		prompt: TranscriptPromptBody;
	}
): Promise<Doc<'threadTranscriptParts'>> {
	const result = await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		sourceKey: promptSourceKey(args.runId),
		kind: 'prompt',
		runId: args.runId,
		prompt: args.prompt,
		work: { ranges: [] }
	});

	return result.part;
}

export async function recordHiddenPrompts(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		idempotencyScope: string;
		prompts: HiddenPrompt[];
	}
): Promise<Doc<'threadTranscriptParts'>[]> {
	const parts: Doc<'threadTranscriptParts'>[] = [];

	for (const prompt of args.prompts) {
		const result = await appendTranscriptPart(ctx, {
			threadId: args.threadId,
			sourceKey: hiddenPromptSourceKey(args.idempotencyScope, prompt.kind),
			kind: 'prompt',
			runId: args.runId,
			prompt: { text: prompt.text, imageUploads: [], hidden: prompt.kind },
			work: { ranges: [] }
		});

		parts.push(result.part);
	}

	return parts;
}

export async function recordCompletionTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		streamId: string;
		items: TranscriptCompletionItem[];
		work: PersistedWork;
		toolInvocations: { toolInvocationId: string }[];
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

	const result = await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		sourceKey: completionSourceKey(args.runId, args.streamId),
		kind: 'completion',
		runId: args.runId,
		completion: { items: args.items },
		work: { ...args.work, toolInvocations }
	});

	return result.part;
}

export async function recordStartedToolTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		job: TranscriptToolJob;
	}
): Promise<void> {
	await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		sourceKey: toolSourceKey(args.job.toolInvocationId, 'started'),
		kind: 'tool',
		runId: args.runId,
		tool: progressToolBody(args.job, { status: 'started' }),
		work: args.job.sectionKey ? { ranges: [], sectionKey: args.job.sectionKey } : { ranges: [] }
	});
}

export async function recordToolTranscript(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		job: TranscriptToolJob;
		preserveExistingDisplay?: boolean;
	}
): Promise<Doc<'threadTranscriptParts'> | null> {
	if (!isSettledExecutorJobStatus(args.job.status)) {
		return null;
	}

	const sourceKey = toolSourceKey(args.job.toolInvocationId, 'finished');
	const tool = settledToolBody(args.job);

	let work: PersistedWork = args.job.sectionKey
		? { ranges: [], sectionKey: args.job.sectionKey }
		: { ranges: [] };

	if (args.preserveExistingDisplay) {
		const existing = await ctx.db
			.query('threadTranscriptParts')
			.withIndex('by_threadId_and_sourceKey', (query) =>
				query.eq('threadId', args.threadId).eq('sourceKey', sourceKey)
			)
			.unique();

		if (existing?.tool) tool.output = existing.tool.output;

		if (existing && args.job.sectionKey === undefined) work = existing.work;
	}

	const result = await appendTranscriptPart(ctx, {
		threadId: args.threadId,
		sourceKey,
		kind: 'tool',
		runId: args.runId,
		tool,
		work
	});

	return result.part;
}

export async function recordSettledToolTranscripts(
	ctx: MutationCtx,
	args: {
		threadId: Id<'threadRecords'>;
		runId: Id<'runs'>;
		toolInvocations: { toolInvocationId: string }[];
	}
): Promise<Doc<'threadTranscriptParts'>[]> {
	const parts: Doc<'threadTranscriptParts'>[] = [];

	for (const { toolInvocationId } of args.toolInvocations) {
		const job = await ctx.db
			.query('executorJobs')
			.withIndex('by_runId_and_toolInvocationId', (query) =>
				query.eq('runId', args.runId).eq('toolInvocationId', toolInvocationId)
			)
			.unique();

		if (job) {
			const part = await recordToolTranscript(ctx, {
				threadId: args.threadId,
				runId: args.runId,
				job
			});

			if (part) parts.push(part);
		}
	}

	return parts;
}

function progressToolBody(
	job: TranscriptToolJob,
	args: { status: TranscriptToolBody['status']; output?: TranscriptToolBody['output'] }
): TranscriptToolBody {
	const body: TranscriptToolBody = {
		toolInvocationId: job.toolInvocationId,
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
							? 'Tool stopped before completion.'
							: 'Executor job failed.'),
					status
				};

	return progressToolBody(job, { status, output });
}
