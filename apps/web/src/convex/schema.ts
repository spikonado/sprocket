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
	vReasoningEffort,
	vRunStatus,
	vServiceTier,
	vSubscriptionStatus,
	vSubscriptionTier,
	vThreadMessageType,
	vTranscriptCompletionBody,
	vTranscriptPartKind,
	vTranscriptPromptBody,
	vTranscriptToolBody
} from '@convex/lib/validators';

export default defineSchema({
	users: defineTable({
		// WorkOS JWT subject; every owned table stores this value as `userId`.
		subject: v.string(),
		tokenIdentifier: v.string(),
		email: v.string(),
		createdAt: v.number()
	}).index('by_subject', ['subject']),
	installations: defineTable({
		userId: v.string(),
		installationId: v.string(),
		friendlyName: v.string(),
		platform: v.string(),
		platformVersion: v.optional(v.string()),
		architecture: v.string(),
		hostname: v.optional(v.string()),
		appVersion: v.string(),
		currentSessionId: v.optional(v.id('machineSessions')),
		createdAt: v.number(),
		updatedAt: v.number()
	}).index('by_userId_and_installationId', ['userId', 'installationId']),
	machineSessions: defineTable({
		userId: v.string(),
		installationId: v.string(),
		processSessionId: v.string(),
		credentialHash: v.string(),
		startedAt: v.number(),
		lastSeenAt: v.number(),
		supersededAt: v.optional(v.number()),
		revokedAt: v.optional(v.number())
	}).index('by_userId_and_processSessionId', ['userId', 'processSessionId']),
	machineSessionRuns: defineTable({
		sessionId: v.id('machineSessions'),
		runId: v.id('runs'),
		active: v.boolean()
	})
		.index('by_sessionId_and_active', ['sessionId', 'active'])
		.index('by_runId', ['runId']),
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
		// Deprecated: only present on rows written by older clients. New clients
		// resume the latest active thread instead.
		lastThreadId: v.optional(v.id('threadRecords')),
		theme: v.optional(v.union(v.literal('light'), v.literal('dark'))),
		// Deprecated: mandate setup uses the WorkOS identity email. Kept so
		// rows written by older clients still validate.
		paymentsEmail: v.optional(v.string())
	}).index('by_userId', ['userId']),
	// Stored-only. New clients do not write these tables. Kept so existing
	// documents and leftover `projectId` fields validate until the rewrite
	// unsets them. See BACKWARDS_COMPATIBILITY.md.
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
		.index('by_user_repositoryKey', ['userId', 'repositoryKey']),
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
		// Leftover optionality after the repository-key backfill. Current
		// inserts always write it.
		repositoryKey: v.optional(v.string()),
		// Deprecated: present on rows written before threads stored repositoryKey.
		projectId: v.optional(v.id('projects')),
		title: v.optional(v.string()),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		contextSummary: v.optional(v.string()),
		contextSummaryThroughRunId: v.optional(v.id('runs')),
		lastMessageAt: v.number(),
		archivedAt: v.optional(v.number())
	})
		.index('by_userId_submissionId', ['userId', 'submissionId'])
		.index('by_userId_repositoryKey', ['userId', 'repositoryKey'])
		.index('by_userId_and_repositoryKey_and_archivedAt_and_lastMessageAt', [
			'userId',
			'repositoryKey',
			'archivedAt',
			'lastMessageAt'
		]),
	threadSnapshotRevisions: defineTable({
		userId: v.string(),
		repositoryKey: v.string(),
		category: v.union(v.literal('active'), v.literal('archived')),
		revision: v.number(),
		updatedAt: v.number()
	}).index('by_userId_and_repositoryKey_and_category', ['userId', 'repositoryKey', 'category']),
	threadUsage: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		contextTokens: v.optional(v.number()),
		// Denormalized cache of the Aggregate ledger. See
		// BACKWARDS_COMPATIBILITY.md (stored schema, usage ledger).
		totalTokensProcessed: v.number(),
		// Leftover after the usage-ledger backfill.
		usageLedgerMigratedAt: v.optional(v.number())
	}).index('by_threadId', ['threadId']),
	threadUsageEvents: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		eventId: v.string(),
		processedTokens: v.number(),
		createdAt: v.number()
	}).index('by_threadId_eventId', ['threadId', 'eventId']),
	runs: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		submissionId: v.string(),
		// Deprecated: leftover on rows written when runs belonged to a cloud project.
		projectId: v.optional(v.id('projects')),
		status: vRunStatus,
		// Hash of the bearer capability held only by the local executor.
		executionSecretHash: v.string(),
		// Optional on stored rows written before machine-session binding. New runs set both.
		installationId: v.optional(v.string()),
		executorSessionId: v.optional(v.id('machineSessions')),
		continuationOfRunId: v.optional(v.id('runs')),
		claimId: v.optional(v.string()),
		claimExpiresAt: v.optional(v.number()),
		completionAttemptSeq: v.number(),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		catalogVersion: v.optional(v.string()),
		// Stored historical rows may still say `convex-action`; new inserts are `gateway`.
		completionTransport: v.optional(v.union(v.literal('convex-action'), v.literal('gateway'))),
		gatewayProtocolVersion: v.optional(v.number()),
		agentVersion: v.optional(v.string()),
		contextWindowTokens: v.optional(v.number()),
		autoCompactTokenLimit: v.optional(v.number()),
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		cancellationRequestedAt: v.optional(v.number()),
		cancellationDeadlineAt: v.optional(v.number()),
		activeJobId: v.optional(v.id('executorJobs')),
		promptMessageId: v.optional(v.id('threadMessages')),
		// Deprecated: new runs do not write a response message. Kept on leftover
		// rows until a migration removes them; then this field can go away.
		responseMessageId: v.optional(v.id('threadMessages')),
		completionStreamStateId: v.optional(v.id('completionStreamStates')),
		lifecycleWorkflowId: v.optional(v.string())
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
		// Deprecated: only response rows written before the local-transcript
		// cleanup populate this. New response rows (none are written anymore)
		// would store an empty array. Remove the field once all existing rows
		// have been rewritten by `migrations.clearResponseMessageParts` and the
		// rust/desktop read gates pass; see BACKWARDS_COMPATIBILITY.md.
		parts: v.array(vAssistantMessagePart)
	}).index('by_type_runId', ['type', 'runId']),
	// Durable numbered transcript replica source. Kept off threadRecords so
	// appends do not invalidate the thread list subscription.
	threadTranscriptStates: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		totalParts: v.number(),
		// Leftover after the numbered-transcript backfill.
		migratedAt: v.optional(v.number())
	}).index('by_threadId', ['threadId']),
	threadTranscriptParts: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		number: v.number(),
		sourceKey: v.string(),
		kind: vTranscriptPartKind,
		runId: v.id('runs'),
		prompt: v.optional(vTranscriptPromptBody),
		completion: v.optional(vTranscriptCompletionBody),
		tool: v.optional(vTranscriptToolBody)
	})
		.index('by_threadId_and_number', ['threadId', 'number'])
		.index('by_threadId_and_sourceKey', ['threadId', 'sourceKey'])
		.index('by_threadId_and_runId_and_number', ['threadId', 'runId', 'number']),
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
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		// Deprecated: leftover on rows written when jobs belonged to a cloud project.
		projectId: v.optional(v.id('projects')),
		kind: vExecutorJobKind,
		callId: v.optional(v.string()),
		// Set on jobs created after tool progress events. Legacy rows omit it;
		// transcript writes fall back to the job document id.
		toolInvocationId: v.optional(v.string()),
		payload: vExecutorJobPayload,
		hidden: v.boolean(),
		status: vExecutorJobStatus,
		enqueuedAt: v.number(),
		claimedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		result: v.optional(vExecutorJobResult),
		error: v.optional(v.string()),
		sequence: v.number(),
		cloudWorkId: v.optional(v.string())
	})
		.index('by_threadId_sequence', ['threadId', 'sequence'])
		.index('by_runId_sequence', ['runId', 'sequence'])
		.index('by_runId_hidden_sequence', ['runId', 'hidden', 'sequence'])
		.index('by_runId_and_callId_and_hidden', ['runId', 'callId', 'hidden']),
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
		reportRetrierRunId: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_mandate_reference', ['mandateId', 'reference'])
		.index('by_reportRetrierRunId', ['reportRetrierRunId']),
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
