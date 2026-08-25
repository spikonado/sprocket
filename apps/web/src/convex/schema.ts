import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	vMandateChargeStatus,
	vMandateFrequency,
	vMandateReportOutcome,
	vMandateScope,
	vMandateStatus
} from '@convex/lib/validators';
import {
	vAgentQuestionStatus,
	vArtifactType,
	vAskQuestionAnswer,
	vAskQuestionOption,
	vAssistantMessagePart,
	vExecutorJobKind,
	vExecutorJobPayload,
	vExecutorJobResult,
	vExecutorJobStatus,
	vPersistedModelId,
	vReasoningEffort,
	vRunStatus,
	vServiceTier,
	vSubscriptionStatus,
	vSubscriptionTier,
	vThreadMessageType
} from '@convex/lib/validators';

export default defineSchema({
	users: defineTable({
		// WorkOS JWT subject; every owned table stores this value as `userId`.
		subject: v.string(),
		tokenIdentifier: v.string(),
		email: v.optional(v.string()),
		createdAt: v.number()
	}).index('by_subject', ['subject']),
	billingCustomers: defineTable({
		userId: v.string(),
		dodoCustomerId: v.string()
	}).index('by_userId', ['userId']),
	subscriptions: defineTable({
		userId: v.string(),
		tier: vSubscriptionTier,
		dodoSubscriptionId: v.string(),
		dodoProductId: v.string(),
		status: vSubscriptionStatus,
		eventAt: v.number()
	}).index('by_userId', ['userId']),
	uiPreferences: defineTable({
		userId: v.string(),
		// Deprecated: only older released clients still write/read this via
		// setLastThread. New clients resume the latest active thread instead.
		// Remove once those clients age out.
		lastThreadId: v.optional(v.id('threadRecords')),
		theme: v.optional(v.union(v.literal('light'), v.literal('dark'))),
		// Deprecated: mandate setup now uses the WorkOS identity email. Kept so
		// rows written by older clients still validate; see
		// BACKWARDS_COMPATIBILITY.md before removing.
		paymentsEmail: v.optional(v.string())
	}).index('by_userId', ['userId']),
	projects: defineTable({
		userId: v.string(),
		repositoryKey: v.string(),
		displayName: v.string(),
		// Deprecated: executor liveness moved to `projectConnections`. No longer
		// written; kept optional so pre-migration rows still validate.
		lastHeartbeatAt: v.optional(v.number()),
		connectedClientId: v.optional(v.string()),
		nextExecutorSequence: v.number(),
		lastSeenAt: v.number()
	})
		.index('by_userId', ['userId'])
		.index('by_user_repositoryKey', ['userId', 'repositoryKey']),
	// Executor liveness lives apart from `projects` so heartbeats don't
	// invalidate `projects.listMine` subscriptions.
	projectConnections: defineTable({
		projectId: v.id('projects'),
		userId: v.string(),
		clientId: v.string(),
		lastHeartbeatAt: v.number()
	})
		.index('by_projectId', ['projectId'])
		.index('by_userId', ['userId']),
	threadRecords: defineTable({
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
	})
		.index('by_userId_lastMessageAt', ['userId', 'lastMessageAt'])
		.index('by_userId_submissionId', ['userId', 'submissionId']),
	threadUsage: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		contextTokens: v.optional(v.number()),
		totalTokensProcessed: v.number()
	}).index('by_threadId', ['threadId']),
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
		parts: v.array(vAssistantMessagePart)
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
		.index('by_threadId_status_sequence', ['threadId', 'status', 'sequence']),
	artifacts: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		title: v.string(),
		type: vArtifactType,
		currentVersion: v.number(),
		createdById: v.id('runs'),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_threadId', ['threadId'])
		.index('by_threadId_title', ['threadId', 'title']),
	artifactVersions: defineTable({
		artifactId: v.id('artifacts'),
		userId: v.string(),
		version: v.number(),
		content: v.string(),
		createdAt: v.number()
	}).index('by_artifactId_version', ['artifactId', 'version']),
	mandates: defineTable({
		userId: v.string(),
		// Present only after the owner approves in Prava.
		pravaMandateId: v.optional(v.string()),
		pravaSessionId: v.string(),
		// Omitted for any-merchant mandates.
		merchantName: v.optional(v.string()),
		merchantUrl: v.optional(v.string()),
		countryCode: v.optional(v.string()),
		// Integer minor units (cents). Prava decimal strings convert at the boundary.
		amountCap: v.number(),
		currency: v.string(),
		frequency: vMandateFrequency,
		scope: vMandateScope,
		status: vMandateStatus,
		description: v.string(),
		approvalUrl: v.string(),
		validUntil: v.optional(v.string()),
		renewsAt: v.optional(v.string()),
		remaining: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number()
	}).index('by_user', ['userId']),
	mandateCharges: defineTable({
		mandateId: v.id('mandates'),
		runId: v.id('runs'),
		userId: v.string(),
		pravaTransactionId: v.optional(v.string()),
		// Integer minor units (cents).
		amount: v.number(),
		currency: v.string(),
		description: v.string(),
		// When set, (mandateId, reference) is an idempotency key for mandateCharge.
		reference: v.optional(v.string()),
		status: vMandateChargeStatus,
		reportOutcome: v.optional(vMandateReportOutcome),
		reportedAt: v.optional(v.number()),
		reportingStartedAt: v.optional(v.number()),
		chargingStartedAt: v.optional(v.number()),
		// Set immediately before POST /charge. After a transport error the remote
		// may have committed, so a row with this set and no transaction id must
		// not be reclaimed for another provider request.
		providerRequestedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number()
	}).index('by_mandate_reference', ['mandateId', 'reference']),
	browserSessions: defineTable({
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		lastUsedRunId: v.id('runs'),
		userId: v.string(),
		browserbaseSessionId: v.string(),
		liveViewUrl: v.optional(v.string()),
		startedAt: v.number()
	}).index('by_thread', ['threadId'])
});
