import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	vAgentQuestionStatus,
	vAskQuestionAnswer,
	vAskQuestionOption,
	vExecutorJobKind,
	vExecutorJobPayload,
	vExecutorJobResult,
	vExecutorJobStatus,
	vModelId,
	vReasoningEffort,
	vServiceTier,
	vRunStatus,
	vAssistantMessagePart,
	vThreadMessageType,
	vSubscriptionStatus,
	vSubscriptionTier
} from '@convex/lib/validators';

export default defineSchema({
	billingCustomers: defineTable({
		userId: v.string(),
		dodoCustomerId: v.string()
	}).index('by_userId', ['userId']),
	subscriptions: defineTable({
		userId: v.string(),
		tier: vSubscriptionTier,
		dodoSubscriptionId: v.optional(v.string()),
		dodoProductId: v.optional(v.string()),
		status: vSubscriptionStatus,
		eventAt: v.number()
	}).index('by_userId', ['userId']),
	uiPreferences: defineTable({
		userId: v.string(),
		lastThreadId: v.optional(v.id('threadRecords')),
		theme: v.union(v.literal('light'), v.literal('dark'))
	}).index('by_userId', ['userId']),
	projects: defineTable({
		userId: v.string(),
		repositoryKey: v.string(),
		displayName: v.string(),
		lastHeartbeatAt: v.optional(v.number()),
		connectedClientId: v.optional(v.string()),
		nextExecutorSequence: v.number(),
		lastSeenAt: v.number()
	})
		.index('by_userId', ['userId'])
		.index('by_userId_lastSeenAt', ['userId', 'lastSeenAt'])
		.index('by_user_repositoryKey', ['userId', 'repositoryKey']),
	threadRecords: defineTable({
		userId: v.string(),
		submissionId: v.string(),
		projectId: v.id('projects'),
		title: v.optional(v.string()),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		contextTokens: v.optional(v.number()),
		totalTokensProcessed: v.optional(v.number()),
		contextSummary: v.optional(v.string()),
		contextSummaryThroughRunId: v.optional(v.id('runs')),
		lastMessageAt: v.number(),
		archivedAt: v.optional(v.number())
	})
		.index('by_userId_lastMessageAt', ['userId', 'lastMessageAt'])
		.index('by_userId_submissionId', ['userId', 'submissionId']),
	runs: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		submissionId: v.string(),
		projectId: v.id('projects'),
		status: vRunStatus,
		// Hash of the bearer capability held only by the local executor.
		executionSecretHash: v.string(),
		claimId: v.optional(v.string()),
		claimExpiresAt: v.optional(v.number()),
		completionAttemptSeq: v.optional(v.number()),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		activeJobId: v.optional(v.id('executorJobs')),
		promptMessageId: v.optional(v.id('threadMessages')),
		responseMessageId: v.optional(v.id('threadMessages')),
		completionStreamStateId: v.optional(v.id('completionStreamStates'))
	})
		.index('by_threadId_startedAt', ['threadId', 'startedAt'])
		.index('by_threadId_status_startedAt', ['threadId', 'status', 'startedAt'])
		.index('by_executionSecretHash', ['executionSecretHash'])
		.index('by_userId_submissionId', ['userId', 'submissionId']),
	threadMessages: defineTable({
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		userId: v.string(),
		type: vThreadMessageType,
		text: v.string(),
		imageUploadIds: v.optional(v.array(v.id('imageUploads'))),
		parts: v.optional(v.array(vAssistantMessagePart))
	}),
	completionStreamStates: defineTable({
		runId: v.id('runs'),
		userId: v.string(),
		sequence: v.number(),
		streamAttemptId: v.optional(v.string())
	}),
	imageUploads: defineTable({
		userId: v.string(),
		storageId: v.id('_storage'),
		name: v.string(),
		mediaType: v.string(),
		size: v.number(),
		messageIds: v.array(v.id('threadMessages')),
		attached: v.boolean()
	})
		.index('by_userId', ['userId'])
		.index('by_storageId', ['storageId'])
		.index('by_attached', ['attached']),
	executorJobs: defineTable({
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
	})
		.index('by_projectId_sequence', ['projectId', 'sequence'])
		.index('by_threadId_sequence', ['threadId', 'sequence'])
		.index('by_runId_sequence', ['runId', 'sequence'])
		.index('by_runId_hidden_sequence', ['runId', 'hidden', 'sequence']),
	agentQuestions: defineTable({
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
	})
		.index('by_runId_sequence', ['runId', 'sequence'])
		.index('by_threadId_sequence', ['threadId', 'sequence'])
		.index('by_threadId_status_sequence', ['threadId', 'status', 'sequence'])
});
