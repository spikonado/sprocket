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
