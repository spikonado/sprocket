import type { Infer } from 'convex/values';
import type { JsonValue } from '@convex/lib/json';
import { vExecutorJobKind, vExecutorJobStatus } from '@convex/lib/validators';
import type { ExecutorJobPayload, ExecutorJobResult } from '@convex/lib/validators';

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

export type AssistantPart =
	AssistantTextPart | AssistantReasoningPart | AssistantToolCallPart | AssistantToolResultPart;

export type PersistedToolLogEntry = {
	callId: string;
	name: string;
	input: JsonValue;
	output?: JsonValue;
};

export type PersistableExecutorToolJob = {
	id: string;
	kind: Infer<typeof vExecutorJobKind>;
	callId?: string;
	payload: ExecutorJobPayload;
	status: Infer<typeof vExecutorJobStatus>;
	result?: ExecutorJobResult;
	error?: string;
};

export function cloneAssistantToolPayload<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

export function upsertAssistantToolCallPart(
	parts: AssistantPart[],
	indexByCallId: Map<string, number>,
	name: string,
	callId: string,
	input: JsonValue
) {
	const nextPart: AssistantToolCallPart = {
		type: 'tool-call',
		callId,
		name,
		input: cloneAssistantToolPayload(input)
	};
	const existingIndex = indexByCallId.get(callId);
	if (existingIndex !== undefined) {
		parts[existingIndex] = nextPart;
		return;
	}
	const nextIndex = parts.push(nextPart) - 1;
	indexByCallId.set(callId, nextIndex);
}

export function upsertAssistantToolResultPart(
	parts: AssistantPart[],
	indexByCallId: Map<string, number>,
	callId: string,
	toolResult: {
		name?: string;
		output: JsonValue;
	}
) {
	const nextPart: AssistantToolResultPart = {
		type: 'tool-result',
		callId,
		...(toolResult.name ? { name: toolResult.name } : {}),
		output: cloneAssistantToolPayload(toolResult.output)
	};
	const existingIndex = indexByCallId.get(callId);
	if (existingIndex !== undefined) {
		parts[existingIndex] = nextPart;
		return;
	}
	const nextIndex = parts.push(nextPart) - 1;
	indexByCallId.set(callId, nextIndex);
}

export function buildPersistedToolLogs(parts: AssistantPart[]): PersistedToolLogEntry[] {
	const logsByCallId = new Map<string, PersistedToolLogEntry>();
	const orderedLogs: PersistedToolLogEntry[] = [];

	for (const part of parts) {
		if (part.type !== 'tool-call' && part.type !== 'tool-result') {
			continue;
		}

		const existing = logsByCallId.get(part.callId);

		if (part.type === 'tool-call') {
			if (existing) {
				existing.name = part.name;
				existing.input = part.input;
				continue;
			}

			const nextEntry: PersistedToolLogEntry = {
				callId: part.callId,
				name: part.name,
				input: part.input
			};
			logsByCallId.set(part.callId, nextEntry);
			orderedLogs.push(nextEntry);
			continue;
		}

		if (existing) {
			if (part.name) {
				existing.name = part.name;
			}
			existing.output = part.output;
			continue;
		}

		const nextEntry: PersistedToolLogEntry = {
			callId: part.callId,
			name: part.name ?? 'tool',
			input: {},
			output: part.output
		};
		logsByCallId.set(part.callId, nextEntry);
		orderedLogs.push(nextEntry);
	}

	return orderedLogs;
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
	const usedCallIds = new Set<string>();

	for (const job of jobs) {
		const exactCall = unmatchedCalls.find((part) => {
			if (usedCallIds.has(part.callId)) return false;
			if (job.callId) return part.callId === job.callId;
			return part.name === job.kind && JSON.stringify(part.input) === JSON.stringify(job.payload);
		});
		const streamedCall =
			exactCall ??
			(job.callId
				? undefined
				: unmatchedCalls.find((part) => !usedCallIds.has(part.callId) && part.name === job.kind));
		const callId = job.callId ?? streamedCall?.callId ?? `executor-job:${job.id}`;
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
				output: {
					error: job.error ?? 'Executor job failed.'
				}
			});
			resultCallIds.add(callId);
			continue;
		}

		if (job.status === 'cancelled') {
			nextParts.splice(insertAt, 0, {
				type: 'tool-result',
				callId,
				name: job.kind,
				output: {
					error: job.error ?? 'Executor job cancelled before completion.'
				}
			});
			resultCallIds.add(callId);
		}
	}

	return removeAbandonedAssistantTurns(nextParts, new Set([...usedCallIds, ...resultCallIds]));
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
