export type AssistantTextPart = {
	type: 'text';
	id: string;
	text: string;
};

export type AssistantReasoningPart = {
	type: 'reasoning';
	id: string;
	text: string;
};

export type AssistantToolCallPart = {
	type: 'tool-call';
	callId: string;
	name: string;
	input: unknown;
};

export type AssistantToolResultPart = {
	type: 'tool-result';
	callId: string;
	name?: string;
	output: unknown;
};

export type AssistantPart =
	| AssistantTextPart
	| AssistantReasoningPart
	| AssistantToolCallPart
	| AssistantToolResultPart;

export type PersistedToolLogEntry = {
	callId: string;
	name: string;
	input: unknown;
	output?: unknown;
};

export type PersistableExecutorToolJob = {
	id: string;
	kind: string;
	payload: unknown;
	status: string;
	result?: unknown;
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
	input: unknown
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
		output: unknown;
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

export function ensureAssistantToolPartsFromJobs(
	parts: AssistantPart[],
	jobs: PersistableExecutorToolJob[]
): AssistantPart[] {
	if (
		parts.some((part) => {
			return part.type === 'tool-call' || part.type === 'tool-result';
		})
	) {
		return parts;
	}

	if (jobs.length === 0) {
		return parts;
	}

	const nextParts = [...parts];
	for (const job of jobs) {
		const callId = `executor-job:${job.id}`;
		nextParts.push({
			type: 'tool-call',
			callId,
			name: job.kind,
			input: cloneAssistantToolPayload(job.payload)
		});

		if (job.status === 'completed' && job.result !== undefined) {
			nextParts.push({
				type: 'tool-result',
				callId,
				name: job.kind,
				output: cloneAssistantToolPayload(job.result)
			});
			continue;
		}

		if (job.status === 'failed') {
			nextParts.push({
				type: 'tool-result',
				callId,
				name: job.kind,
				output: {
					error: job.error ?? 'Executor job failed.'
				}
			});
			continue;
		}

		if (job.status === 'cancelled') {
			nextParts.push({
				type: 'tool-result',
				callId,
				name: job.kind,
				output: {
					error: job.error ?? 'Executor job cancelled before completion.'
				}
			});
		}
	}

	return nextParts;
}
