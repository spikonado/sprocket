import {
	matchAssistantToolCallsToJobs,
	parseAssistantToolResultError,
	type AssistantPart,
	type AssistantToolCallPart
} from '$convex/lib/assistantParts';
import { isJsonObject, type JsonValue } from '$convex/lib/json';
import { jsonBoolean, jsonObjectString } from '$lib/chat/json-fields';
import type { ExecutorJob, ThreadMessage } from '$lib/types/sprocket';

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
			key: string;
			blocks: AssistantTimelineWorkBlock[];
	  }
	| Extract<AssistantTimelineBlock, { type: 'text' }>;

export type AssistantTimelineToolFailureKind = 'cancelled' | 'failed' | 'interrupted';

export function isAssistantResponseStreaming(
	message: Pick<ThreadMessage, 'runId' | 'runStatus'>,
	activeRunId: ThreadMessage['runId'] | null
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
export function assistantTimelineWorkSectionKey(block: AssistantTimelineWorkBlock): string {
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

function forEachWorkSectionJob(
	blocks: AssistantTimelineWorkBlock[],
	visit: (job: NonNullable<AssistantTimelineTool['job']>) => void
) {
	for (const block of blocks) {
		if (block.type !== 'tool-group') continue;
		for (const tool of block.tools) {
			if (tool.job) visit(tool.job);
		}
	}
}

/** Earliest durable job start in a work section, if any. */
export function workSectionJobStartedAtMs(
	blocks: AssistantTimelineWorkBlock[]
): number | undefined {
	let startMs: number | undefined;
	forEachWorkSectionJob(blocks, (job) => {
		const jobStart = job.claimedAt ?? job.enqueuedAt;
		startMs = startMs === undefined ? jobStart : Math.min(startMs, jobStart);
	});
	return startMs;
}

/** Latest durable job completion in a work section, if any. */
export function workSectionJobCompletedAtMs(
	blocks: AssistantTimelineWorkBlock[]
): number | undefined {
	let endMs: number | undefined;
	forEachWorkSectionJob(blocks, (job) => {
		if (job.completedAt === undefined) return;
		endMs = endMs === undefined ? job.completedAt : Math.max(endMs, job.completedAt);
	});
	return endMs;
}

/**
 * Precompute work-section indexes and prior-completion anchors so the transcript
 * can resolve timing without O(n²) slice/filter per section.
 */
export type WorkSectionTimingIndexes = {
	workIndexBySectionIndex: Array<number | undefined>;
	priorCompletedAtByWorkIndex: Array<number | undefined>;
};

export function workSectionTimingIndexes(
	sections: AssistantTimelineSection[]
): WorkSectionTimingIndexes {
	const workIndexBySectionIndex: Array<number | undefined> = [];
	const priorCompletedAtByWorkIndex: Array<number | undefined> = [];
	let workIndex = 0;
	let priorEnd: number | undefined;

	for (const section of sections) {
		if (section.type !== 'work') {
			workIndexBySectionIndex.push(undefined);
			continue;
		}

		workIndexBySectionIndex.push(workIndex);
		priorCompletedAtByWorkIndex.push(priorEnd);
		const sectionEnd = workSectionJobCompletedAtMs(section.blocks);
		if (sectionEnd !== undefined) {
			priorEnd = priorEnd === undefined ? sectionEnd : Math.max(priorEnd, sectionEnd);
		}
		workIndex += 1;
	}

	return { workIndexBySectionIndex, priorCompletedAtByWorkIndex };
}

export type WorkSectionTimingAnchor = {
	startedAtMs: number;
	completedAtMs?: number;
};

/**
 * Durable wall-clock anchors for a work section from Convex job/run timestamps.
 * First section starts at run start; later sections prefer job start / prior work end.
 */
export function workSectionTimingAnchor(
	section: Extract<AssistantTimelineSection, { type: 'work' }>,
	options: {
		inProgress: boolean;
		/** 0-based index among work sections in this assistant message. */
		workSectionIndex: number;
		runStartedAt: number;
		runCompletedAt?: number;
		/** Latest job completion among earlier work sections in this message. */
		priorWorkCompletedAtMs?: number;
	}
): WorkSectionTimingAnchor {
	const jobStartedAtMs = workSectionJobStartedAtMs(section.blocks);
	const startedAtMs =
		options.workSectionIndex === 0
			? options.runStartedAt
			: (jobStartedAtMs ?? options.priorWorkCompletedAtMs ?? options.runStartedAt);

	if (options.inProgress) {
		return { startedAtMs };
	}

	const completedAtMs =
		workSectionJobCompletedAtMs(section.blocks) ?? options.runCompletedAt ?? startedAtMs;

	return { startedAtMs, completedAtMs };
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

/** Whether a tool call is still in flight while the run is streaming. */
export function isAssistantTimelineToolRunning(
	tool: AssistantTimelineTool,
	isStreaming: boolean
): boolean {
	return isStreaming && isAssistantTimelineToolUnresolved(tool);
}

/** Session id from command tool output, else input/payload (write_stdin completion omits it). */
function commandSessionIdFromTool(tool: AssistantTimelineTool): string | undefined {
	return (
		jsonObjectString(tool.output, 'sessionId') ??
		jsonObjectString(tool.input, 'sessionId') ??
		jsonObjectString(tool.job?.payload, 'sessionId')
	);
}

/** Map session id → shell command from exec_command / write_stdin results. */
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
			(assistantTimelineToolKey(tool) === 'exec_command'
				? (jsonObjectString(tool.input, 'cmd') ?? jsonObjectString(tool.job?.payload, 'cmd'))
				: undefined);
		if (cmd) {
			sessionCommands.set(sessionId, cmd);
		}
	}

	return sessionCommands;
}

/** User-facing command label for write_stdin / open sessions. */
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
 * Sessions still running that also have an exec_command row.
 * Returns empty when the run is not streaming so yielded commands settle after a crash/stop.
 * Later tool outputs win on the running flag (write_stdin completion clears the session).
 * Pass the full message tool list so monitors after text section breaks still close sessions.
 */
export function buildOpenExecCommandSessions(
	tools: readonly AssistantTimelineTool[],
	isStreaming: boolean
): Set<string> {
	if (!isStreaming) {
		return new Set();
	}

	const sessionRunning = new Map<string, boolean>();
	const execSessions = new Set<string>();

	for (const tool of tools) {
		const sessionId = commandSessionIdFromTool(tool);
		if (!sessionId) {
			continue;
		}
		if (assistantTimelineToolKey(tool) === 'exec_command') {
			execSessions.add(sessionId);
		}
		const running = isJsonObject(tool.output) ? jsonBoolean(tool.output.running) : undefined;
		if (running !== undefined) {
			sessionRunning.set(sessionId, running);
		}
	}

	return new Set([...execSessions].filter((sessionId) => sessionRunning.get(sessionId) === true));
}

/**
 * Split a work section's blocks into settled content (reasoning + finished tools) and
 * currently running tools pulled out for a separate Running dropdown.
 *
 * Open command sessions stay in Running across write_stdin monitor polls until a later
 * monitor reports running:false. Prefer message-wide `openSessions` so text-separated
 * sections share the same session lifecycle.
 */
export type PartitionedWorkSectionTools = {
	settledBlocks: AssistantTimelineWorkBlock[];
	runningTools: AssistantTimelineTool[];
};

export function partitionWorkSectionTools(
	blocks: AssistantTimelineWorkBlock[],
	isStreaming: boolean,
	openSessions: ReadonlySet<string>
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
			const kind = assistantTimelineToolKey(tool);
			const sessionId = commandSessionIdFromTool(tool);
			const sessionOpen = sessionId !== undefined && openSessions.has(sessionId);
			const traditionallyRunning = isAssistantTimelineToolRunning(tool, isStreaming);

			if (kind === 'exec_command' && sessionOpen) {
				runningTools.push(tool);
				continue;
			}

			if (kind === 'write_stdin') {
				if (traditionallyRunning) {
					// Prefer the open exec_command row over in-flight monitor polls.
					if (!sessionOpen) {
						runningTools.push(tool);
					}
					continue;
				}
				settledTools.push(tool);
				continue;
			}

			if (traditionallyRunning) {
				runningTools.push(tool);
			} else {
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
	jobs: ExecutorJob[],
	detailsLoaded = true
): AssistantTimelineItem[] {
	const resultsByCallId = new Map(
		parts
			.filter((part): part is Extract<AssistantPart, { type: 'tool-result' }> => {
				return part.type === 'tool-result';
			})
			.map((part) => [part.callId, part] as const)
	);
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
		if (part.type === 'reasoning' && !detailsLoaded) {
			timeline.push(part);
			continue;
		}
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
