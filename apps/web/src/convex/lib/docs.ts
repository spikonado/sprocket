import { v } from 'convex/values';
import { vCompletionStreamEvent } from '@convex/lib/completionStream';
import { vJsonValue } from '@convex/lib/json';
import {
	vAgentHistoryMessage,
	vAgentQuestionStatus,
	vArtifactType,
	vAskQuestionAnswer,
	vAskQuestionOption,
	vAssistantMessagePart,
	vExecutorJobKind,
	vExecutorJobPayload,
	vExecutorJobResult,
	vExecutorJobStatus,
	vExecutorStatus,
	vModelId,
	vPersistedModelId,
	vReasoningEffort,
	vRunStatus,
	vServiceTier,
	vSubscriptionStatus,
	vSubscriptionTier,
	vThreadMessageType
} from '@convex/lib/validators';

/** Table field validators shared by schema and document return validators. */

export const projectFields = {
	userId: v.string(),
	repositoryKey: v.string(),
	displayName: v.string(),
	// Deprecated: executor liveness moved to `projectConnections`. No longer
	// written; kept optional so pre-migration rows still validate.
	lastHeartbeatAt: v.optional(v.number()),
	connectedClientId: v.optional(v.string()),
	nextExecutorSequence: v.number(),
	lastSeenAt: v.number()
};

export const threadRecordFields = {
	userId: v.string(),
	submissionId: v.string(),
	projectId: v.id('projects'),
	title: v.optional(v.string()),
	selectedModel: vPersistedModelId,
	reasoningEffort: vReasoningEffort,
	serviceTier: vServiceTier,
	contextSummary: v.optional(v.string()),
	contextSummaryThroughRunId: v.optional(v.id('runs')),
	lastMessageAt: v.number(),
	archivedAt: v.optional(v.number())
};

export const threadUsageFields = {
	threadId: v.id('threadRecords'),
	userId: v.string(),
	contextTokens: v.optional(v.number()),
	totalTokensProcessed: v.number()
};

export const runFields = {
	threadId: v.id('threadRecords'),
	userId: v.string(),
	submissionId: v.string(),
	projectId: v.id('projects'),
	status: vRunStatus,
	// Hash of the bearer capability held only by the local executor.
	executionSecretHash: v.string(),
	claimId: v.optional(v.string()),
	claimExpiresAt: v.optional(v.number()),
	completionAttemptSeq: v.number(),
	selectedModel: vPersistedModelId,
	reasoningEffort: vReasoningEffort,
	serviceTier: vServiceTier,
	startedAt: v.number(),
	completedAt: v.optional(v.number()),
	lastError: v.optional(v.string()),
	activeJobId: v.optional(v.id('executorJobs')),
	promptMessageId: v.optional(v.id('threadMessages')),
	responseMessageId: v.optional(v.id('threadMessages')),
	completionStreamStateId: v.optional(v.id('completionStreamStates'))
};

export const threadMessageFields = {
	threadId: v.id('threadRecords'),
	runId: v.id('runs'),
	userId: v.string(),
	type: vThreadMessageType,
	text: v.string(),
	imageUploadIds: v.optional(v.array(v.id('imageUploads'))),
	parts: v.array(vAssistantMessagePart)
};

export const executorJobFields = {
	projectId: v.id('projects'),
	threadId: v.id('threadRecords'),
	runId: v.id('runs'),
	kind: vExecutorJobKind,
	callId: v.optional(v.string()),
	payload: vExecutorJobPayload,
	hidden: v.boolean(),
	status: vExecutorJobStatus,
	enqueuedAt: v.number(),
	claimedAt: v.optional(v.number()),
	completedAt: v.optional(v.number()),
	result: v.optional(vExecutorJobResult),
	error: v.optional(v.string()),
	sequence: v.number()
};

export const agentQuestionFields = {
	threadId: v.id('threadRecords'),
	runId: v.id('runs'),
	jobId: v.id('executorJobs'),
	question: v.string(),
	options: v.array(vAskQuestionOption),
	status: vAgentQuestionStatus,
	answer: v.optional(vAskQuestionAnswer),
	createdAt: v.number(),
	timeoutAt: v.number(),
	answeredAt: v.optional(v.number()),
	sequence: v.number()
};

export const uiPreferencesFields = {
	userId: v.string(),
	// Deprecated: only older released clients still write/read this via
	// setLastThread. New clients resume the latest active thread instead.
	// Remove once those clients age out.
	lastThreadId: v.optional(v.id('threadRecords')),
	theme: v.optional(v.union(v.literal('light'), v.literal('dark'))),
	paymentsEmail: v.optional(v.string())
};

export const imageUploadFields = {
	userId: v.string(),
	storageId: v.id('_storage'),
	name: v.string(),
	mediaType: v.string(),
	size: v.number(),
	messageIds: v.array(v.id('threadMessages')),
	attached: v.boolean()
};

export const completionStreamStateFields = {
	runId: v.id('runs'),
	userId: v.string(),
	sequence: v.number(),
	streamAttemptId: v.optional(v.string())
};

export const billingCustomerFields = {
	userId: v.string(),
	dodoCustomerId: v.string()
};

export const subscriptionFields = {
	userId: v.string(),
	tier: vSubscriptionTier,
	dodoSubscriptionId: v.string(),
	dodoProductId: v.string(),
	status: vSubscriptionStatus,
	eventAt: v.number()
};

export const artifactFields = {
	threadId: v.id('threadRecords'),
	userId: v.string(),
	title: v.string(),
	type: vArtifactType,
	currentVersion: v.number(),
	createdById: v.id('runs'),
	createdAt: v.number(),
	updatedAt: v.number()
};

export const artifactVersionFields = {
	artifactId: v.id('artifacts'),
	userId: v.string(),
	version: v.number(),
	content: v.string(),
	createdAt: v.number()
};

/** Document validators (table fields + Convex system fields). */

export const vProjectDoc = v.object({
	_id: v.id('projects'),
	_creationTime: v.number(),
	...projectFields
});

export const vThreadRecordDoc = v.object({
	_id: v.id('threadRecords'),
	_creationTime: v.number(),
	...threadRecordFields
});

// getByThreadId's live response shape: thread record plus usage counters
// merged in from the threadUsage table.
export const vThreadWithUsageDoc = v.object({
	_id: v.id('threadRecords'),
	_creationTime: v.number(),
	...threadRecordFields,
	contextTokens: v.optional(v.number()),
	totalTokensProcessed: v.number()
});

export const vRunDoc = v.object({
	_id: v.id('runs'),
	_creationTime: v.number(),
	...runFields
});

export const vThreadMessageDoc = v.object({
	_id: v.id('threadMessages'),
	_creationTime: v.number(),
	...threadMessageFields
});

export const vExecutorJobDoc = v.object({
	_id: v.id('executorJobs'),
	_creationTime: v.number(),
	...executorJobFields
});

export const vAgentQuestionDoc = v.object({
	_id: v.id('agentQuestions'),
	_creationTime: v.number(),
	...agentQuestionFields
});

export const vUiPreferencesDoc = v.object({
	_id: v.id('uiPreferences'),
	_creationTime: v.number(),
	...uiPreferencesFields
});

export const vImageUploadDoc = v.object({
	_id: v.id('imageUploads'),
	_creationTime: v.number(),
	...imageUploadFields
});

export const vProjectListItem = v.object({
	_id: v.id('projects'),
	_creationTime: v.number(),
	...projectFields,
	// Absent for `listMine({ includeExecutorStatus: false })` callers.
	executorStatus: v.optional(vExecutorStatus)
});

export const vThreadTranscriptAttachment = v.object({
	imageUploadId: v.id('imageUploads'),
	name: v.string(),
	mediaType: v.string(),
	size: v.number(),
	url: v.string()
});

export const vThreadTranscriptMessage = v.object({
	_id: v.id('threadMessages'),
	_creationTime: v.number(),
	...threadMessageFields,
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

export const vThreadSummary = v.object({
	_id: v.id('threadRecords'),
	_creationTime: v.number(),
	...threadRecordFields,
	threadId: v.id('threadRecords'),
	title: v.string(),
	threadStatus: v.union(v.literal('archived'), v.literal('active')),
	latestRunStatus: v.union(vRunStatus, v.null()),
	latestRunId: v.union(v.id('runs'), v.null()),
	latestRunStartedAt: v.optional(v.number()),
	latestRunClaimExpiresAt: v.optional(v.number()),
	hasActiveRun: v.boolean()
});

export const vRuntimePromptAttachment = v.object({
	mediaType: v.string(),
	url: v.string()
});

export const vGetContextResult = v.object({
	run: vRunDoc,
	threadRecord: vThreadRecordDoc,
	project: vProjectDoc,
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
	run: v.union(vRunDoc, v.null()),
	jobs: v.array(vExecutorJobDoc),
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
