import { v, type Infer } from 'convex/values';

export const vCompletionStreamEvent = v.union(
	v.object({
		type: v.literal('text'),
		id: v.string(),
		text: v.string(),
		turnId: v.optional(v.string()),
		providerMetadata: v.optional(v.any())
	}),
	v.object({
		type: v.literal('reasoning'),
		id: v.string(),
		text: v.string(),
		turnId: v.optional(v.string()),
		providerReasoningId: v.optional(v.string()),
		providerMetadata: v.optional(v.any())
	}),
	v.object({
		type: v.literal('toolCall'),
		partId: v.string(),
		callId: v.string(),
		name: v.string(),
		input: v.any(),
		turnId: v.optional(v.string()),
		providerMetadata: v.optional(v.any())
	})
);

export type CompletionStreamEvent = Infer<typeof vCompletionStreamEvent>;

export function classifyCompletionStreamBatch(args: {
	lastSequence: number;
	lastStreamId?: string;
	sequence: number;
	streamId: string;
}): 'append' | 'duplicate' {
	if (args.sequence === args.lastSequence) {
		if (args.streamId === args.lastStreamId) return 'duplicate';
		throw new Error(
			`Assistant stream ${args.streamId} cannot reuse batch ${args.sequence} from stream ${args.lastStreamId ?? 'unknown'}.`
		);
	}
	if (args.sequence < args.lastSequence) {
		throw new Error(
			`Assistant stream batch ${args.sequence} is stale; latest batch is ${args.lastSequence}.`
		);
	}
	if (args.sequence !== args.lastSequence + 1) {
		throw new Error(
			`Assistant stream batch ${args.sequence} arrived after ${args.lastSequence}; expected ${args.lastSequence + 1}.`
		);
	}
	return 'append';
}

export function appendCompletionStreamEvent(
	events: CompletionStreamEvent[],
	event: CompletionStreamEvent
): void {
	const previous = events.at(-1);
	if (
		previous &&
		(previous.type === 'text' || previous.type === 'reasoning') &&
		previous.type === event.type &&
		(event.type === 'text' || event.type === 'reasoning') &&
		previous.id === event.id
	) {
		previous.text += event.text;
		if (event.turnId !== undefined) previous.turnId = event.turnId;
		if (event.providerMetadata !== undefined) {
			previous.providerMetadata = event.providerMetadata;
		}
		if (previous.type === 'reasoning' && event.type === 'reasoning') {
			if (event.providerReasoningId !== undefined) {
				previous.providerReasoningId = event.providerReasoningId;
			}
		}
		return;
	}
	events.push({ ...event });
}

export function upsertCompletionTextEvent(
	events: CompletionStreamEvent[],
	event: Extract<CompletionStreamEvent, { type: 'text' }>
): void {
	const existing = events.find(
		(candidate): candidate is Extract<CompletionStreamEvent, { type: 'text' }> =>
			candidate.type === 'text' && candidate.id === event.id
	);
	if (!existing) {
		events.push({ ...event });
		return;
	}
	existing.text += event.text;
	if (event.turnId !== undefined) existing.turnId = event.turnId;
	if (event.providerMetadata !== undefined) {
		existing.providerMetadata = event.providerMetadata;
	}
}

export function upsertCompletionReasoningEvent(
	events: CompletionStreamEvent[],
	event: Extract<CompletionStreamEvent, { type: 'reasoning' }>
): void {
	const existing = events.find(
		(candidate): candidate is Extract<CompletionStreamEvent, { type: 'reasoning' }> =>
			candidate.type === 'reasoning' && candidate.id === event.id
	);
	if (!existing) {
		events.push({ ...event });
		return;
	}
	existing.text += event.text;
	if (event.turnId !== undefined) existing.turnId = event.turnId;
	if (event.providerReasoningId !== undefined) {
		existing.providerReasoningId = event.providerReasoningId;
	}
	if (event.providerMetadata !== undefined) {
		existing.providerMetadata = event.providerMetadata;
	}
}
