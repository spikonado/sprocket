import { v } from 'convex/values';
import schema from '@convex/schema';
import {
	vAgentHistoryMessage,
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

export const vThreadSummary = schema.doc('threadRecords').extend({
	threadId: v.id('threadRecords'),
	repositoryKey: v.string(),
	title: v.string(),
	threadStatus: v.union(v.literal('archived'), v.literal('active')),
	latestRunStatus: v.union(vRunStatus, v.null()),
	latestRunId: v.union(v.id('runs'), v.null()),
	latestRunStartedAt: v.optional(v.number()),
	latestRunClaimExpiresAt: v.optional(v.number()),
	hasActiveRun: v.boolean()
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

export const vAttachmentDownloadResult = v.union(
	v.null(),
	v.object({
		imageUploadId: v.id('imageUploads'),
		name: v.string(),
		mediaType: v.string(),
		size: v.number(),
		storageId: v.id('_storage'),
		url: v.string()
	})
);

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

export const vRegisterImageUploadSuccess = v.object({
	imageUploadId: v.id('imageUploads'),
	name: v.string(),
	mediaType: v.string(),
	size: v.number(),
	url: v.string()
});

export const vRegisterImageUploadResult = v.union(
	vRegisterImageUploadSuccess,
	v.object({ error: v.string() })
);

export const vCheckoutResponse = v.object({
	checkout_url: v.string()
});

export const vCustomerPortalResponse = v.object({
	portal_url: v.string()
});

export const vRuntimePromptAttachment = v.object({
	mediaType: v.string(),
	url: v.string()
});

export const vGetContextResult = v.object({
	run: schema.doc('runs'),
	threadRecord: schema.doc('threadRecords'),
	prompt: v.string(),
	promptAttachments: v.array(vRuntimePromptAttachment),
	agentHistory: v.array(vAgentHistoryMessage),
	contextBudget: v.object({
		contextWindowTokens: v.number(),
		autoCompactTokenLimit: v.number()
	})
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

export const vLatestRunForThread = v.object({
	threadId: v.id('threadRecords'),
	run: v.union(schema.doc('runs'), v.null()),
	jobs: v.array(schema.doc('executorJobs')),
	prompt: v.optional(v.string()),
	imageUploadIds: v.optional(v.array(v.id('imageUploads'))),
	serverNow: v.number()
});

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
