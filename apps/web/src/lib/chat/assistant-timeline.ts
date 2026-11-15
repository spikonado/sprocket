import { parseAssistantToolResultError, type AssistantPart } from '@convex/lib/assistantParts';
import type { JsonValue } from '@convex/lib/json';
import { isCommandToolKind, isExecCommandToolKind } from '@convex/lib/commandToolKinds';
import { jsonObjectString } from '$lib/chat/json-fields';
import type { LiveTranscriptMessage } from '$lib/types/sprocket';

export type AssistantTimelineTool = {
	type: 'tool';
	callId: string;
	name: string;
	input: JsonValue;
	output?: JsonValue;
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

function assistantTimelineToolKey(tool: AssistantTimelineTool): string {
	return tool.name || 'tool';
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
	return tool.output === undefined;
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
	return jsonObjectString(tool.output, 'sessionId') ?? jsonObjectString(tool.input, 'sessionId');
}

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
				? jsonObjectString(tool.input, 'cmd')
				: undefined);

		if (cmd) {
			sessionCommands.set(sessionId, cmd);
		}
	}

	return sessionCommands;
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

	return parseAssistantToolResultError(item.output)?.status;
}

export function assistantTimelineToolError(
	item: AssistantTimelineTool,
	isStreaming: boolean
): string | undefined {
	if (!isStreaming && isAssistantTimelineToolUnresolved(item)) {
		return 'The agent stopped before this tool call finished.';
	}

	return parseAssistantToolResultError(item.output)?.error;
}

export function buildAssistantTimeline(parts: AssistantPart[]): AssistantTimelineItem[] {
	const resultsByCallId = new Map<string, Extract<AssistantPart, { type: 'tool-result' }>>();

	parts.forEach((part) => {
		if (part.type === 'tool-result') {
			resultsByCallId.set(part.callId, part);
		}
	});

	const timeline: AssistantTimelineItem[] = [];

	for (const part of parts) {
		if (part.type === 'tool-result') continue;

		if (part.type === 'reasoning' || part.type === 'text') {
			if (part.text.trim().length > 0) timeline.push(part);
			continue;
		}

		const result = resultsByCallId.get(part.callId);

		const item: AssistantTimelineTool = {
			type: 'tool',
			callId: part.callId,
			name: part.name,
			input: part.input
		};

		if (result) {
			item.output = result.output;
		}

		timeline.push(item);
	}

	return timeline;
}
