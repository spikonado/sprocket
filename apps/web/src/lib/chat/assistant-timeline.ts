import {
	matchAssistantToolCallsToJobs,
	parseAssistantToolResultError,
	type AssistantPart,
	type AssistantToolCallPart
} from '$convex/lib/assistantParts';
import type { JsonValue } from '$convex/lib/json';
import type { ExecutorJob } from '$lib/types/sprocket';

export type AssistantTimelineItem =
	| Extract<AssistantPart, { type: 'text' | 'reasoning' }>
	| {
			type: 'tool';
			callId: string;
			name: string;
			input: JsonValue;
			output?: JsonValue;
			job?: ExecutorJob;
	  };

export type AssistantTimelineToolFailureKind = 'cancelled' | 'failed';

export function assistantTimelineToolFailureKind(
	item: Extract<AssistantTimelineItem, { type: 'tool' }>
): AssistantTimelineToolFailureKind | undefined {
	if (item.job?.status === 'cancelled' || item.job?.status === 'failed') {
		return item.job.status;
	}

	return parseAssistantToolResultError(item.output)?.status;
}

export function assistantTimelineToolError(
	item: Extract<AssistantTimelineItem, { type: 'tool' }>
): string | undefined {
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
