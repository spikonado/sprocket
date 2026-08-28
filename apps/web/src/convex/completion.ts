import { v } from 'convex/values';
import { action } from '@convex/_generated/server';
import { unsupportedClient } from '@convex/lib/unsupportedClient';

/** Retired Convex completion path. Kept so older agents get an update message. */
export const complete = action({
	args: {
		modelId: v.optional(v.string()),
		reasoningEffort: v.optional(v.string()),
		serviceTier: v.optional(v.string()),
		instructions: v.optional(v.string()),
		prompt: v.optional(v.string()),
		messagesJson: v.optional(v.string()),
		streamRunId: v.optional(v.string()),
		claimId: v.optional(v.string()),
		attemptSeq: v.optional(v.number()),
		streamId: v.optional(v.string()),
		executionSecret: v.optional(v.string()),
		supersededStreamIds: v.optional(v.array(v.string())),
		toolChoiceJson: v.optional(v.string()),
		tools: v.optional(
			v.array(
				v.object({
					name: v.string(),
					description: v.string(),
					parametersJson: v.string()
				})
			)
		)
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const summarize = action({
	args: {
		modelId: v.optional(v.string()),
		reasoningEffort: v.optional(v.string()),
		serviceTier: v.optional(v.string()),
		messagesJson: v.optional(v.string()),
		runId: v.optional(v.string()),
		claimId: v.optional(v.string()),
		executionSecret: v.optional(v.string())
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});
