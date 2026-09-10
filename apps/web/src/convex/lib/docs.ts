import { v } from 'convex/values';
import schema from '@convex/schema';
import {
	vAgentQuestionStatus,
	vAskQuestionAnswer,
	vAskQuestionOption,
	vRunStatus,
	vSubscriptionTier
} from '@convex/lib/validators';

/** Function argument/return validators derived from the schema plus hand-shaped results. */

// getByThreadId's live response shape: thread record plus usage counters
// merged in from the threadUsage table.
export const vThreadWithUsageDoc = schema.doc('threadRecords').extend({
	contextTokens: v.optional(v.number()),
	totalTokensProcessed: v.number()
});

export const vTranscriptStateResult = v.object({
	threadId: v.id('threadRecords'),
	totalParts: v.number(),
	historyFromNumber: v.number(),
	contextSummary: v.optional(v.string())
});

export const vTranscriptPartsResult = v.object({
	threadId: v.id('threadRecords'),
	parts: v.array(schema.doc('threadTranscriptParts'))
});

export const vRegisterFileSuccess = v.object({
	storageId: v.id('_storage'),
	name: v.string(),
	mediaType: v.string(),
	size: v.number(),
	url: v.string()
});

export const vAttachmentFileDownloadResult = v.union(v.null(), vRegisterFileSuccess);

export const vRegisterFileResult = v.union(vRegisterFileSuccess, v.object({ error: v.string() }));

export const vAgentQuestionSnapshot = v.object({
	threadId: v.id('threadRecords'),
	questionId: v.id('agentQuestions'),
	question: v.string(),
	options: v.array(vAskQuestionOption),
	status: vAgentQuestionStatus,
	answer: v.optional(vAskQuestionAnswer),
	sequence: v.number(),
	createdAt: v.number(),
	timeoutAt: v.number(),
	answeredAt: v.optional(v.number())
});

export const vCheckoutResponse = v.object({
	checkout_url: v.string()
});

export const vCustomerPortalResponse = v.object({
	portal_url: v.string()
});

export const vGetContextResult = v.object({
	run: schema.doc('runs'),
	prompt: v.string(),
	contextTokens: v.optional(v.number())
});

export const vCompletionActor = v.object({
	userId: v.string(),
	threadId: v.id('threadRecords'),
	status: vRunStatus,
	claimId: v.optional(v.string()),
	claimExpiresAt: v.optional(v.number()),
	completionAttemptSeq: v.number(),
	streamSequence: v.number(),
	streamAttemptId: v.optional(v.string())
});

export {
	vSelectedThreadLifecycle,
	vSelectedThreadLifecyclePhase,
	vSelectedThreadLifecycleRun
} from '@convex/lib/runCancellation';

export const vUsageMeterWindow = v.object({
	period: v.union(v.literal('weekly'), v.literal('monthly')),
	used: v.number(),
	limit: v.number(),
	resetsAt: v.union(v.number(), v.null())
});

export const vMyUsage = v.object({
	tier: vSubscriptionTier,
	exhausted: v.boolean(),
	resetsAt: v.union(v.number(), v.null()),
	meters: v.array(
		v.object({
			id: v.literal('modelUsage'),
			label: v.string(),
			description: v.string(),
			windows: v.array(vUsageMeterWindow)
		})
	)
});
