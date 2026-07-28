import type { Infer } from 'convex/values';
import { isJsonObject, type JsonValue } from '@convex/lib/json';
import type {
	AssistantToolResultErrorOutput,
	AssistantToolResultErrorStatus,
	ExecutorJobPayload,
	ExecutorJobResult,
	vExecutorJobKind,
	vExecutorJobStatus
} from '@convex/lib/validators';

export type AssistantTextPart = {
	type: 'text';
	id: string;
	text: string;
	turnId?: string;
	providerMetadata?: JsonValue;
};

export type AssistantReasoningPart = {
	type: 'reasoning';
	id: string;
	text: string;
	turnId?: string;
	providerMetadata?: JsonValue;
};

export type AssistantToolCallPart = {
	type: 'tool-call';
	partId?: string;
	callId: string;
	name: string;
	input: JsonValue;
	turnId?: string;
	providerMetadata?: JsonValue;
};

export type AssistantToolResultPart = {
	type: 'tool-result';
	callId: string;
	name?: string;
	output: JsonValue;
};

export type { AssistantToolResultErrorOutput, AssistantToolResultErrorStatus };

export function parseAssistantToolResultError(
	output: JsonValue | undefined
): AssistantToolResultErrorOutput | undefined {
	if (!isJsonObject(output) || typeof output.error !== 'string') {
		return undefined;
	}
	if (output.status !== 'cancelled' && output.status !== 'failed') {
		return undefined;
	}
	return { error: output.error, status: output.status };
}

function assistantToolResultErrorOutput(
	status: AssistantToolResultErrorStatus,
	error: string
): AssistantToolResultErrorOutput {
	return { error, status };
}

export type AssistantPart =
	AssistantTextPart | AssistantReasoningPart | AssistantToolCallPart | AssistantToolResultPart;

export type PersistableExecutorToolJob = {
	id: string;
	kind: Infer<typeof vExecutorJobKind>;
	callId?: string;
	payload: ExecutorJobPayload;
	status: Infer<typeof vExecutorJobStatus>;
	result?: ExecutorJobResult;
	error?: string;
};

export type MatchableExecutorToolJob = Pick<
	PersistableExecutorToolJob,
	'id' | 'kind' | 'callId' | 'payload'
>;

type PersistableExecutorJobSource = {
	_id: string;
	hidden?: boolean;
	sequence: number;
	kind: Infer<typeof vExecutorJobKind>;
	callId?: string;
	payload: ExecutorJobPayload;
	status: Infer<typeof vExecutorJobStatus>;
	result?: ExecutorJobResult;
	error?: string;
};

export function toPersistableExecutorToolJobs(
	jobs: readonly PersistableExecutorJobSource[]
): PersistableExecutorToolJob[] {
	return jobs
		.filter((job) => !job.hidden)
		.sort((left, right) => left.sequence - right.sequence)
		.map((job) => ({
			id: job._id,
			kind: job.kind,
			...(job.callId ? { callId: job.callId } : {}),
			payload: job.payload,
			status: job.status,
			result: job.result,
			error: job.error
		}));
}

function cloneAssistantToolPayload<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

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
	if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
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

export function ensureAssistantToolPartsFromJobs(
	parts: AssistantPart[],
	jobs: PersistableExecutorToolJob[]
): AssistantPart[] {
	const nextParts = parts.map((part) => cloneAssistantToolPayload(part));
	const resultCallIds = new Set(
		nextParts
			.filter((part): part is AssistantToolResultPart => part.type === 'tool-result')
			.map((part) => part.callId)
	);

	if (jobs.length === 0) {
		return removeAbandonedAssistantTurns(nextParts, resultCallIds);
	}

	const unmatchedCalls = nextParts.filter(
		(part): part is AssistantToolCallPart => part.type === 'tool-call'
	);
	const matchedCallIds = matchAssistantToolCallsToJobs(unmatchedCalls, jobs);
	const matchedCallIdSet = new Set(matchedCallIds.values());
	const ambiguousAnchors = unmatchedCalls.filter((call) => !matchedCallIdSet.has(call.callId));
	const usedAnchorCallIds = new Set<string>();
	const replacedAnchorCallIds = new Set<string>();
	const usedCallIds = new Set<string>();

	for (const job of jobs) {
		const matchedCallId = matchedCallIds.get(job.id);
		let streamedCall = matchedCallId
			? unmatchedCalls.find((part) => part.callId === matchedCallId)
			: undefined;
		const callId = job.callId ?? streamedCall?.callId ?? `executor-job:${job.id}`;
		if (!streamedCall && !job.callId) {
			const anchor = ambiguousAnchors.find(
				(call) => call.name === job.kind && !usedAnchorCallIds.has(call.callId)
			);
			if (anchor) {
				usedAnchorCallIds.add(anchor.callId);
				replacedAnchorCallIds.add(anchor.callId);
				const anchorIndex = nextParts.indexOf(anchor);
				const replacement: AssistantToolCallPart = {
					type: 'tool-call',
					callId,
					name: job.kind,
					input: cloneAssistantToolPayload(job.payload),
					...(anchor.turnId ? { turnId: anchor.turnId } : {})
				};
				nextParts[anchorIndex] = replacement;
				streamedCall = replacement;
			}
		}
		usedCallIds.add(callId);
		let insertAt: number;
		if (streamedCall) {
			streamedCall.name = job.kind;
			streamedCall.input = cloneAssistantToolPayload(job.payload);
			insertAt = nextParts.indexOf(streamedCall) + 1;
		} else {
			nextParts.push({
				type: 'tool-call',
				callId,
				name: job.kind,
				input: cloneAssistantToolPayload(job.payload)
			});
			insertAt = nextParts.length;
		}

		if (resultCallIds.has(callId)) {
			continue;
		}

		if (job.status === 'completed' && job.result !== undefined) {
			nextParts.splice(insertAt, 0, {
				type: 'tool-result',
				callId,
				name: job.kind,
				output: cloneAssistantToolPayload(job.result)
			});
			resultCallIds.add(callId);
			continue;
		}

		if (job.status === 'failed') {
			nextParts.splice(insertAt, 0, {
				type: 'tool-result',
				callId,
				name: job.kind,
				output: assistantToolResultErrorOutput('failed', job.error ?? 'Executor job failed.')
			});
			resultCallIds.add(callId);
			continue;
		}

		if (job.status === 'cancelled') {
			nextParts.splice(insertAt, 0, {
				type: 'tool-result',
				callId,
				name: job.kind,
				output: assistantToolResultErrorOutput(
					'cancelled',
					job.error ?? 'Executor job cancelled before completion.'
				)
			});
			resultCallIds.add(callId);
		}
	}

	const reconciledParts = nextParts.filter(
		(part) => part.type !== 'tool-result' || !replacedAnchorCallIds.has(part.callId)
	);
	return removeAbandonedAssistantTurns(
		reconciledParts,
		new Set([...usedCallIds, ...resultCallIds])
	);
}

function removeAbandonedAssistantTurns(
	parts: AssistantPart[],
	retainedCallIds: ReadonlySet<string>
): AssistantPart[] {
	const abandonedCalls = parts.filter(
		(part): part is AssistantToolCallPart =>
			part.type === 'tool-call' && !retainedCallIds.has(part.callId)
	);
	const callsByTurnId = new Map<string, AssistantToolCallPart[]>();
	for (const part of parts) {
		if (part.type !== 'tool-call' || part.turnId === undefined) continue;
		const turnCalls = callsByTurnId.get(part.turnId) ?? [];
		turnCalls.push(part);
		callsByTurnId.set(part.turnId, turnCalls);
	}
	const abandonedTurnIds = new Set(
		[...callsByTurnId]
			.filter(([, calls]) => calls.every((call) => !retainedCallIds.has(call.callId)))
			.map(([turnId]) => turnId)
	);
	const removedCallIds = new Set(abandonedCalls.map((part) => part.callId));

	return parts.filter((part) => {
		if (part.type === 'tool-result') {
			return !removedCallIds.has(part.callId);
		}
		if (part.turnId !== undefined && abandonedTurnIds.has(part.turnId)) {
			return false;
		}
		return part.type !== 'tool-call' || !removedCallIds.has(part.callId);
	});
}
