import { v } from 'convex/values';
import schema from '@convex/schema';
import { vCompletionStreamEvent } from '@convex/lib/completionStream';
import { vJsonValue } from '@convex/lib/json';
import {
	vAgentHistoryMessage,
	vAgentQuestionStatus,
	vAskQuestionAnswer,
	vAskQuestionOption,
	vExecutorStatus,
	vModelId,
	vReasoningEffort,
	vRunStatus,
	vServiceTier,
	vSubscriptionTier
} from '@convex/lib/validators';

/** Function argument/return validators derived from the schema plus hand-shaped results. */

// getByThreadId's live response shape: thread record plus usage counters
// merged in from the threadUsage table.
export const vThreadWithUsageDoc = schema.doc('threadRecords').extend({
	contextTokens: v.optional(v.number()),
	totalTokensProcessed: v.number()
});

export const vProjectListItem = schema.doc('projects').extend({
	// Absent when the caller skips live status or omits `now`.
	executorStatus: v.optional(vExecutorStatus)
});

export const vThreadSummary = schema.doc('threadRecords').extend({
	threadId: v.id('threadRecords'),
	title: v.string(),
	threadStatus: v.union(v.literal('archived'), v.literal('active')),
	latestRunStatus: v.union(vRunStatus, v.null()),
	latestRunId: v.union(v.id('runs'), v.null()),
	latestRunStartedAt: v.optional(v.number()),
	latestRunClaimExpiresAt: v.optional(v.number()),
	hasActiveRun: v.boolean()
});

export const vThreadTranscriptAttachment = v.object({
	imageUploadId: v.id('imageUploads'),
	name: v.string(),
	mediaType: v.string(),
	size: v.number(),
	url: v.string()
});

export const vThreadTranscriptMessage = schema.doc('threadMessages').extend({
	attachments: v.array(vThreadTranscriptAttachment),
	runStatus: vRunStatus,
	runStartedAt: v.number(),
	runCompletedAt: v.optional(v.number())
});

export const vThreadTranscriptQueryResult = v.object({
	threadId: v.id('threadRecords'),
	messages: v.array(vThreadTranscriptMessage)
});

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
	project: schema.doc('projects'),
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

/** Best-effort AI SDK LanguageModelUsage shape (complete/summarize actions). */
export const vLanguageModelUsage = v.object({
	inputTokens: v.optional(v.number()),
	inputTokenDetails: v.object({
		noCacheTokens: v.optional(v.number()),
		cacheReadTokens: v.optional(v.number()),
		cacheWriteTokens: v.optional(v.number())
	}),
	outputTokens: v.optional(v.number()),
	outputTokenDetails: v.object({
		textTokens: v.optional(v.number()),
		reasoningTokens: v.optional(v.number())
	}),
	totalTokens: v.optional(v.number()),
	// Opaque provider payload; AI SDK's JSONObject allows undefined values.
	raw: v.optional(v.any())
});

export const vCompletionStreamMergeResult = v.union(
	v.literal('duplicate'),
	v.literal('superseded'),
	v.literal('merged')
);

export const vModelProvider = v.union(
	v.literal('stealth'),
	v.literal('openai'),
	v.literal('anthropic'),
	v.literal('zai'),
	v.literal('kimi'),
	v.literal('deepseek')
);

export const vCatalogModel = v.object({
	id: vModelId,
	label: v.string(),
	provider: vModelProvider,
	supportsImages: v.boolean(),
	contextWindowTokens: v.number(),
	autoCompactTokenLimit: v.number(),
	reasoningEfforts: v.array(vReasoningEffort),
	defaultReasoningEffort: vReasoningEffort,
	serviceTiers: v.array(vServiceTier),
	usagePolicy: v.optional(v.literal('unlimited'))
});

export const vModelCatalog = v.object({
	defaultModelId: vModelId,
	defaultReasoningEffort: vReasoningEffort,
	defaultServiceTier: vServiceTier,
	models: v.array(vCatalogModel),
	tierAllowedModels: v.object({
		free: v.array(vModelId),
		pro: v.array(vModelId),
		admin: v.array(vModelId)
	}),
	tierAllowedServiceTiers: v.object({
		free: v.array(vServiceTier),
		pro: v.array(vServiceTier),
		admin: v.array(vServiceTier)
	}),
	modelLockUpgradeMessage: v.string(),
	serviceTierLockUpgradeMessage: v.string()
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

export const vCompleteActionResult = v.object({
	text: v.string(),
	usage: vLanguageModelUsage,
	message_id: v.optional(v.string()),
	tool_calls: v.array(
		v.object({
			id: v.string(),
			name: v.string(),
			arguments: vJsonValue,
			provider_metadata: v.optional(vJsonValue)
		})
	),
	stream_events: v.array(vCompletionStreamEvent)
});

export const vSummarizeActionResult = v.object({
	summary: v.string(),
	usage: vLanguageModelUsage
});
