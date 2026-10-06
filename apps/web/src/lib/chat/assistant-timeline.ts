import {
	matchAssistantToolCallsToJobs,
	parseAssistantToolResultError,
	type AssistantPart,
	type AssistantToolCallPart
} from '@convex/lib/assistantParts';
import type { JsonValue } from '@convex/lib/json';
import { isCommandToolKind, isExecCommandToolKind } from '@convex/lib/commandToolKinds';
import { jsonObjectString } from '$lib/chat/json-fields';
import type { ExecutorJob, LiveTranscriptMessage } from '$lib/types/sprocket';

export type AssistantTimelineTool = {
	type: 'tool';
	callId: string;
	name: string;
	input: JsonValue;
	output?: JsonValue;
	job?: ExecutorJob;
	startedAt?: number;
	completedAt?: number;
};

export type AssistantTimelineItem =
	Extract<AssistantPart, { type: 'text' | 'reasoning' }> | AssistantTimelineTool;

export type AssistantTimelineBlock =
	| Extract<AssistantTimelineItem, { type: 'text' | 'reasoning' }>
	| {
			type: 'tool-group';
			toolKey: string;
			tools: AssistantTimelineTool[];
	  };

export type AssistantTimelineWorkBlock = Exclude<AssistantTimelineBlock, { type: 'text' }>;

export type AssistantTimelineSection =
	| {
			type: 'work';
			key: string;
			blocks: AssistantTimelineWorkBlock[];
	  }
	| Extract<AssistantTimelineBlock, { type: 'text' }>;

export type AssistantTimelineToolFailureKind = 'cancelled' | 'failed' | 'interrupted';

export function isAssistantResponseStreaming(
	message: Pick<LiveTranscriptMessage, 'runId' | 'runStatus'>,
	activeRunId: LiveTranscriptMessage['runId'] | null
): boolean {
	return message.runId === activeRunId;
}

/** Tool type used for grouping: prefer streamed call name so groups stay stable as jobs attach. */
export function assistantTimelineToolKey(tool: AssistantTimelineTool): string {
	return tool.name || tool.job?.kind || 'tool';
}

/**
 * Group consecutive same-type tool calls. Text and reasoning always break a group;
 * a different tool key starts a new group even when contiguous.
 */
export function groupAssistantTimeline(items: AssistantTimelineItem[]): AssistantTimelineBlock[] {
	const blocks: AssistantTimelineBlock[] = [];

	for (const item of items) {
		if (item.type === 'text' || item.type === 'reasoning') {
			blocks.push(item);
			continue;
		}

		const toolKey = assistantTimelineToolKey(item);
		const last = blocks.at(-1);

		if (last?.type === 'tool-group' && last.toolKey === toolKey) {
			last.tools.push(item);
			continue;
		}

		blocks.push({ type: 'tool-group', toolKey, tools: [item] });
	}

	return blocks;
}

export function assistantTimelinePartKey(
	part: Extract<AssistantTimelineItem, { type: 'text' | 'reasoning' }>
): string {
	return `${part.type}:${part.turnId ?? ''}:${part.id}`;
}

/** Use the unpartitioned group so running tools settling does not change the key. */
function assistantTimelineWorkSectionKey(block: AssistantTimelineWorkBlock): string {
	if (block.type === 'reasoning') {
		return assistantTimelinePartKey(block);
	}

	return block.tools[0]?.callId ?? block.toolKey;
}

/**
 * Wrap contiguous non-text blocks into work sections. Each text block is its own
 * section and breaks work.
 */
export function groupAssistantTimelineSections(
	blocks: AssistantTimelineBlock[]
): AssistantTimelineSection[] {
	const sections: AssistantTimelineSection[] = [];

	for (const block of blocks) {
		if (block.type === 'text') {
			sections.push(block);
			continue;
		}

		const last = sections.at(-1);

		if (last?.type === 'work') {
			last.blocks.push(block);
			continue;
		}

		sections.push({
			type: 'work',
			key: assistantTimelineWorkSectionKey(block),
			blocks: [block]
		});
	}

	return sections;
}

export type WorkSectionTimingAnchor = {
	startedAtMs?: number;
	completedAtMs?: number;
};

export function workSectionTimingAnchor(
	section: Extract<AssistantTimelineSection, { type: 'work' }>,
	options: {
		inProgress: boolean;
		endedAt?: number;
	}
): WorkSectionTimingAnchor {
	let startedAtMs: number | undefined;
	let completedAtMs = options.endedAt;

	for (const block of section.blocks) {
		const items = block.type === 'tool-group' ? block.tools : [block];

		for (const item of items) {
			// Older transcripts did not record boundaries. A partial duration is misleading.
			if (item.startedAt == null) return {};
			startedAtMs = Math.min(startedAtMs ?? item.startedAt, item.startedAt);

			if (!options.inProgress) {
				const end = item.completedAt ?? options.endedAt;

				if (end === undefined) return {};
				completedAtMs = Math.max(completedAtMs ?? end, end);
			}
		}
	}

	return options.inProgress ? { startedAtMs } : { startedAtMs, completedAtMs };
}

/** Whether a tool call never reached a durable result (no output and no finished job). */
function isAssistantTimelineToolUnresolved(tool: AssistantTimelineTool): boolean {
	if (tool.output !== undefined) {
		return false;
	}

	if (tool.job) {
		return tool.job.status === 'pending' || tool.job.status === 'claimed';
	}

	return true;
}

/** Tools that can yield an operation id and wait for that operation in a later call. */
function isAsyncAssistantTimelineTool(tool: AssistantTimelineTool): boolean {
	const kind = assistantTimelineToolKey(tool);

	return (
		isCommandToolKind(kind) ||
		kind === 'ask_question' ||
		kind === 'await_question' ||
		kind === 'poll_question' ||
		kind === 'spawn_subagent' ||
		kind === 'control_subagent' ||
		kind === 'poll_subagent'
	);
}

/** Whether an async tool call is still in flight while the run is streaming. */
export function isAssistantTimelineToolRunning(
	tool: AssistantTimelineTool,
	isStreaming: boolean
): boolean {
	return (
		isStreaming && isAsyncAssistantTimelineTool(tool) && isAssistantTimelineToolUnresolved(tool)
	);
}

/** Session id from a launch result or a session-bound tool's input. */
function commandSessionIdFromTool(tool: AssistantTimelineTool): string | undefined {
	return (
		jsonObjectString(tool.output, 'sessionId') ??
		jsonObjectString(tool.input, 'sessionId') ??
		jsonObjectString(tool.job?.payload, 'sessionId')
	);
}

/** Map session id → shell command from command tool calls and results. */
export function buildCommandSessionCommandMap(
	tools: readonly AssistantTimelineTool[]
): Map<string, string> {
	const sessionCommands = new Map<string, string>();

	for (const tool of tools) {
		const sessionId = commandSessionIdFromTool(tool);

		if (!sessionId) {
			continue;
		}

		const cmd =
			jsonObjectString(tool.output, 'command') ??
			(isExecCommandToolKind(assistantTimelineToolKey(tool))
				? (jsonObjectString(tool.input, 'cmd') ?? jsonObjectString(tool.job?.payload, 'cmd'))
				: undefined);

		if (cmd) {
			sessionCommands.set(sessionId, cmd);
		}
	}

	return sessionCommands;
}

/** User-facing command label for session-bound command tools. */
export function resolveCommandSessionLabel(
	tool: AssistantTimelineTool,
	sessionCommands: ReadonlyMap<string, string>
): string | undefined {
	const sessionId = commandSessionIdFromTool(tool);

	return (
		jsonObjectString(tool.output, 'command') ??
		(sessionId ? sessionCommands.get(sessionId) : undefined)
	);
}

/**
 * Split a work section's blocks into settled content (reasoning + finished tools) and
 * currently running async tools displayed after the settled content.
 * Unfinished synchronous calls stay hidden until they settle or the run stops.
 */
export type PartitionedWorkSectionTools = {
	settledBlocks: AssistantTimelineWorkBlock[];
	runningTools: AssistantTimelineTool[];
};

export function partitionWorkSectionTools(
	blocks: AssistantTimelineWorkBlock[],
	isStreaming: boolean
): PartitionedWorkSectionTools {
	const settledBlocks: AssistantTimelineWorkBlock[] = [];
	const runningTools: AssistantTimelineTool[] = [];

	for (const block of blocks) {
		if (block.type === 'reasoning') {
			settledBlocks.push(block);
			continue;
		}

		const settledTools: AssistantTimelineTool[] = [];

		for (const tool of block.tools) {
			if (isAssistantTimelineToolRunning(tool, isStreaming)) {
				runningTools.push(tool);
			} else if (!isStreaming || !isAssistantTimelineToolUnresolved(tool)) {
				settledTools.push(tool);
			}
		}

		if (settledTools.length > 0) {
			settledBlocks.push({
				type: 'tool-group',
				toolKey: block.toolKey,
				tools: settledTools
			});
		}
	}

	return { settledBlocks, runningTools };
}

export function assistantTimelineToolFailureKind(
	item: AssistantTimelineTool,
	isStreaming: boolean
): AssistantTimelineToolFailureKind | undefined {
	if (!isStreaming && isAssistantTimelineToolUnresolved(item)) {
		return 'interrupted';
	}

	if (item.job?.status === 'cancelled' || item.job?.status === 'failed') {
		return item.job.status;
	}

	return parseAssistantToolResultError(item.output)?.status;
}

export function assistantTimelineToolError(
	item: AssistantTimelineTool,
	isStreaming: boolean
): string | undefined {
	if (!isStreaming && isAssistantTimelineToolUnresolved(item)) {
		return 'The agent stopped before this tool call finished.';
	}

	const outputError = parseAssistantToolResultError(item.output)?.error;

	if (item.job) {
		if (item.job.status === 'cancelled') {
			return item.job.error ?? outputError ?? 'Executor job cancelled before completion.';
		}

		if (item.job.status === 'failed') {
			return item.job.error ?? outputError ?? 'Executor job failed.';
		}

		return undefined;
	}

	return outputError;
}

export function buildAssistantTimeline(
	parts: AssistantPart[],
	jobs: ExecutorJob[]
): AssistantTimelineItem[] {
	const resultsByCallId = new Map<string, Extract<AssistantPart, { type: 'tool-result' }>>();

	parts.forEach((part) => {
		if (part.type === 'tool-result') {
			resultsByCallId.set(part.callId, part);
		}
	});

	const toolCalls = parts.filter(
		(part): part is AssistantToolCallPart => part.type === 'tool-call'
	);

	const matchedCallIds = matchAssistantToolCallsToJobs(
		toolCalls,
		jobs.map((job) => ({
			id: job._id,
			kind: job.kind,
			callId: job.callId,
			payload: job.payload
		}))
	);

	const jobsByCallId = new Map<string, ExecutorJob>();

	for (const job of jobs) {
		const callId = matchedCallIds.get(job._id);

		if (callId) jobsByCallId.set(callId, job);
	}

	const timeline: AssistantTimelineItem[] = [];
	const usedJobIds = new Set<ExecutorJob['_id']>();

	for (const part of parts) {
		if (part.type === 'tool-result') continue;

		if (part.type === 'reasoning' || part.type === 'text') {
			if (part.text.trim().length > 0) timeline.push(part);
			continue;
		}

		const result = resultsByCallId.get(part.callId);
		const job = jobsByCallId.get(part.callId);

		if (job) usedJobIds.add(job._id);

		const item: AssistantTimelineTool = {
			type: 'tool',
			callId: part.callId,
			name: part.name,
			input: part.input,
			startedAt: part.startedAt ?? job?.enqueuedAt,
			// The call's completedAt ends argument generation, not tool execution.
			completedAt: result?.completedAt ?? job?.completedAt
		};

		if (result) {
			item.output = result.output;
		} else if (job?.result !== undefined) {
			item.output = job.result;
		}

		if (job) {
			item.job = job;
		}

		timeline.push(item);
	}

	for (const job of jobs) {
		if (usedJobIds.has(job._id)) continue;

		const item: AssistantTimelineTool = {
			type: 'tool',
			callId: job.callId ?? `executor-job:${job._id}`,
			name: job.kind,
			input: job.payload,
			startedAt: job.enqueuedAt,
			completedAt: job.completedAt,
			job
		};

		if (job.result !== undefined) {
			item.output = job.result;
		}

		timeline.push(item);
	}

	return timeline;
}
