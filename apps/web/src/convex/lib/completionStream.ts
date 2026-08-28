import { v } from 'convex/values';
import { vJsonValue } from '@convex/lib/json';

export const vCompletionStreamEvent = v.union(
	v.object({
		type: v.literal('text'),
		id: v.string(),
		text: v.string(),
		turnId: v.optional(v.string()),
		providerMetadata: v.optional(vJsonValue)
	}),
	v.object({
		type: v.literal('reasoning'),
		id: v.string(),
		text: v.string(),
		turnId: v.optional(v.string()),
		providerReasoningId: v.optional(v.string()),
		providerMetadata: v.optional(vJsonValue)
	}),
	v.object({
		type: v.literal('toolCall'),
		partId: v.string(),
		callId: v.string(),
		name: v.string(),
		input: vJsonValue,
		turnId: v.optional(v.string()),
		providerMetadata: v.optional(vJsonValue)
	})
);

export const COMPLETION_STREAM_SUPERSEDED = 'SPROCKET_COMPLETION_STREAM_SUPERSEDED';
