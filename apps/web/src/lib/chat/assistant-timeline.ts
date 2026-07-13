import type { AssistantPart } from '$convex/lib/assistantParts';
import { isJsonObject, type JsonValue } from '$convex/lib/json';
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

export function assistantTimelineToolError(
	item: Extract<AssistantTimelineItem, { type: 'tool' }>
): string | undefined {
	const outputError =
		isJsonObject(item.output) && typeof item.output.error === 'string'
			? item.output.error
			: undefined;

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
	const jobsByCallId = new Map<string, ExecutorJob>();
	for (const job of jobs) {
		if (job.callId) jobsByCallId.set(job.callId, job);
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
		const exactJob = jobsByCallId.get(part.callId);
		const job =
			exactJob ??
			jobs.find(
				(candidate) =>
					!candidate.callId && !usedJobIds.has(candidate._id) && candidate.kind === part.name
			);
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
