import {
	matchAssistantToolCallsToJobs,
	parseAssistantToolResultError,
	type AssistantPart,
	type AssistantToolCallPart
} from '@convex/lib/assistantParts';
import { isJsonObject, isJsonString, type JsonValue } from '@convex/lib/json';
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

export function assistantTimelineToolKey(tool: AssistantTimelineTool): string {
	return tool.name || tool.job?.kind || 'tool';
}

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
			blocks: [block]
		});
	}

	return sections;
}

function isAssistantTimelineToolUnresolved(tool: AssistantTimelineTool): boolean {
	if (tool.output !== undefined) {
		return false;
	}

	if (tool.job) {
		return tool.job.status === 'pending' || tool.job.status === 'claimed';
	}

	return true;
}

function isAsyncAssistantTimelineTool(tool: AssistantTimelineTool): boolean {
	const kind = assistantTimelineToolKey(tool);

	return (
		isCommandToolKind(kind) ||
		kind === 'ask_question' ||
		kind === 'await_question' ||
		kind === 'poll_question' ||
		kind === 'card_checkout' ||
		kind === 'poll_checkout' ||
		kind === 'spawn_subagent' ||
		kind === 'control_subagent' ||
		kind === 'poll_subagent' ||
		kind === 'poll_pr'
	);
}

export function isAssistantTimelineToolRunning(
	tool: AssistantTimelineTool,
	isStreaming: boolean
): boolean {
	return (
		isStreaming && isAsyncAssistantTimelineTool(tool) && isAssistantTimelineToolUnresolved(tool)
	);
}

function commandSessionIdFromTool(tool: AssistantTimelineTool): string | undefined {
	return (
		jsonObjectString(tool.output, 'sessionId') ??
		jsonObjectString(tool.input, 'sessionId') ??
		jsonObjectString(tool.job?.payload, 'sessionId')
	);
}

export function buildCommandSessionCommandMap(
	tools: readonly AssistantTimelineTool[]
): Map<string, string> {
	const sessionCommands = new Map<string, string>();

	for (const tool of tools.flatMap(polledTargetTools)) {
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

const POLLED_TARGET_LISTS = new Map([
	['poll_cmd', 'sessionIds'],
	['poll_subagent', 'threads'],
	['poll_pr', 'pullRequests']
]);

/** The only fields an entry for a target that failed to poll carries. */
const FAILED_TARGET_KEYS = new Set(['sessionId', 'threadId', 'repository', 'number', 'error']);

function failedTargetOutput(entry: JsonValue): JsonValue {
	return isJsonObject(entry) &&
		isJsonString(entry.error) &&
		Object.keys(entry).every((key) => FAILED_TARGET_KEYS.has(key))
		? { status: 'failed', error: entry.error }
		: entry;
}

/**
 * Splits a call that polls several targets into one single-target tool per target, so each
 * reads like a historical single-target poll. Result entries carry their target's fields, so
 * they replace the requested targets once present. A failed target's output reads as a failure.
 */
export function polledTargetTools(tool: AssistantTimelineTool): AssistantTimelineTool[] {
	const kind = tool.job?.kind ?? tool.name;
	const listKey = POLLED_TARGET_LISTS.get(kind);

	if (!listKey) return [tool];

	const results = Array.isArray(tool.output) && tool.output.length > 0 ? tool.output : undefined;
	const input: JsonValue | undefined = tool.job?.payload ?? tool.input;
	const requested = isJsonObject(input) ? input[listKey] : undefined;

	const targets =
		results ??
		(Array.isArray(requested)
			? requested.map((target) => (isJsonString(target) ? { sessionId: target } : target))
			: undefined);

	if (!targets) return [tool];

	return targets.map((target, index) => {
		const targetTool: AssistantTimelineTool = {
			type: 'tool',
			callId: `${tool.callId}:${index}`,
			name: kind,
			input: target
		};

		if (results) targetTool.output = failedTargetOutput(target);

		return targetTool;
	});
}

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
			return item.job.error ?? outputError ?? 'Tool stopped before completion.';
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
			input: part.input
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
			job
		};

		if (job.result !== undefined) {
			item.output = job.result;
		}

		timeline.push(item);
	}

	return timeline;
}
