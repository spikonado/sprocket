import {
	matchAssistantToolCallsToJobs,
	parseAssistantToolResultError,
	type AssistantPart,
	type AssistantToolCallPart
} from '$convex/lib/assistantParts';
import type { JsonValue } from '$convex/lib/json';
import type { ExecutorJob } from '$lib/types/sprocket';

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

export type AssistantTimelineToolFailureKind = 'cancelled' | 'failed';

/** Tool type used for grouping: prefer live job kind, else streamed call name. */
export function assistantTimelineToolKey(tool: AssistantTimelineTool): string {
	return tool.job?.kind ?? tool.name;
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

/** Stable identity for a work section from its first nested block. */
export function assistantTimelineWorkSectionKey(block: AssistantTimelineWorkBlock): string {
	if (block.type === 'reasoning') {
		return block.id;
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
export function workSectionTimingIndexes(sections: AssistantTimelineSection[]): {
	workIndexBySectionIndex: Array<number | undefined>;
	priorCompletedAtByWorkIndex: Array<number | undefined>;
} {
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

/** Whether a tool call is still in flight (pending/claimed, or unresolved while streaming). */
export function isAssistantTimelineToolRunning(
	tool: AssistantTimelineTool,
	isStreaming: boolean
): boolean {
	if (tool.job) {
		return tool.job.status === 'pending' || tool.job.status === 'claimed';
	}
	return isStreaming && tool.output === undefined;
}

/**
 * Split a work section's blocks into settled content (reasoning + finished tools) and
 * currently running tools pulled out for a separate Running dropdown.
 */
export function partitionWorkSectionTools(
	blocks: AssistantTimelineWorkBlock[],
	isStreaming: boolean
): {
	settledBlocks: AssistantTimelineWorkBlock[];
	runningTools: AssistantTimelineTool[];
} {
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
	item: AssistantTimelineTool
): AssistantTimelineToolFailureKind | undefined {
	if (item.job?.status === 'cancelled' || item.job?.status === 'failed') {
		return item.job.status;
	}

	return parseAssistantToolResultError(item.output)?.status;
}

export function assistantTimelineToolError(item: AssistantTimelineTool): string | undefined {
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
			...(job.callId ? { callId: job.callId } : {}),
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
		if (part.type === 'text' || part.type === 'reasoning') {
			if (part.text.trim().length > 0) timeline.push(part);
			continue;
		}

		const result = resultsByCallId.get(part.callId);
		const job = jobsByCallId.get(part.callId);
		if (job) usedJobIds.add(job._id);
		timeline.push({
			type: 'tool',
			callId: part.callId,
			name: part.name,
			input: part.input,
			...(result
				? { output: result.output }
				: job?.result !== undefined
					? { output: job.result }
					: {}),
			...(job ? { job } : {})
		});
	}

	for (const job of jobs) {
		if (usedJobIds.has(job._id)) continue;
		timeline.push({
			type: 'tool',
			callId: job.callId ?? `executor-job:${job._id}`,
			name: job.kind,
			input: job.payload,
			...(job.result !== undefined ? { output: job.result } : {}),
			job
		});
	}

	return timeline;
}
