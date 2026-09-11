import type { Infer } from 'convex/values';
import { isJsonObject, isJsonString, type JsonValue } from '@convex/lib/json';
import type {
	AssistantMessagePart,
	AssistantReasoningPart,
	AssistantTextPart,
	AssistantToolCallPart,
	AssistantToolResultErrorOutput,
	AssistantToolResultPart,
	ExecutorJobPayload,
	vExecutorJobKind
} from '@convex/lib/validators';

export type {
	AssistantTextPart,
	AssistantReasoningPart,
	AssistantToolCallPart,
	AssistantToolResultPart
};

export type { AssistantToolResultErrorOutput };

export function parseAssistantToolResultError(
	output: JsonValue | undefined
): AssistantToolResultErrorOutput | undefined {
	if (!isJsonObject(output) || !isJsonString(output.error)) {
		return undefined;
	}
	if (output.status !== 'cancelled' && output.status !== 'failed') {
		return undefined;
	}
	return { error: output.error, status: output.status };
}

export type AssistantPart = AssistantMessagePart;

export type MatchableExecutorToolJob = {
	id: string;
	kind: Infer<typeof vExecutorJobKind>;
	callId?: string;
	payload: ExecutorJobPayload;
};

export function joinAssistantTextParts(parts: AssistantPart[]): string {
	let text = '';
	let previousTurnId: string | undefined;
	let sawText = false;

	for (const part of parts) {
		if (part.type !== 'text' || part.text.length === 0) continue;
		if (
			sawText &&
			previousTurnId !== undefined &&
			part.turnId !== undefined &&
			part.turnId !== previousTurnId
		) {
			text += '\n\n';
		}
		text += part.text;
		if (part.turnId !== undefined) previousTurnId = part.turnId;
		sawText = true;
	}

	return text;
}

export function matchAssistantToolCallsToJobs(
	calls: readonly AssistantToolCallPart[],
	jobs: readonly MatchableExecutorToolJob[]
): Map<string, string> {
	const callIdByJobId = new Map<string, string>();
	const usedCallIds = new Set<string>();
	const unmatchedJobs = jobs.filter((job) => {
		if (!job.callId) return true;
		const call = calls.find(
			(candidate) => candidate.callId === job.callId && !usedCallIds.has(candidate.callId)
		);
		if (!call) return false;
		callIdByJobId.set(job.id, call.callId);
		usedCallIds.add(call.callId);
		return false;
	});

	const matchUnique = (
		matches: (call: AssistantToolCallPart, job: MatchableExecutorToolJob) => boolean
	): void => {
		const availableCalls = calls.filter((call) => !usedCallIds.has(call.callId));
		const candidatesByJob = new Map(
			unmatchedJobs
				.filter((job) => !callIdByJobId.has(job.id))
				.map((job) => [job.id, availableCalls.filter((call) => matches(call, job))] as const)
		);

		for (const job of unmatchedJobs) {
			if (callIdByJobId.has(job.id)) continue;
			const candidates = candidatesByJob.get(job.id) ?? [];
			if (candidates.length !== 1) continue;
			const [call] = candidates;
			const candidateJobs = unmatchedJobs.filter(
				(candidate) =>
					!callIdByJobId.has(candidate.id) &&
					(candidatesByJob.get(candidate.id) ?? []).some(
						(candidateCall) => candidateCall.callId === call.callId
					)
			);
			if (candidateJobs.length !== 1) continue;
			callIdByJobId.set(job.id, call.callId);
			usedCallIds.add(call.callId);
		}
	};

	matchUnique(
		(call, job) => call.name === job.kind && assistantToolPayloadsEqual(call.input, job.payload)
	);
	matchUnique((call, job) => call.name === job.kind);

	return callIdByJobId;
}

function assistantToolPayloadsEqual(left: JsonValue, right: JsonValue): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => assistantToolPayloadsEqual(value, right[index]))
		);
	}
	if (!isJsonObject(left) || !isJsonObject(right)) {
		return false;
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) => Object.hasOwn(right, key) && assistantToolPayloadsEqual(left[key], right[key])
		)
	);
}
