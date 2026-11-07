import { vWorkId } from '@convex-dev/workpool';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { vPrice } from '@convex/lib/pricingValidators';
import { workSectionFields, workMembership } from '@convex/lib/workSections';
import { commandSnapshot } from '@convex/lib/commandSessions';
import { vProviderOrderEntry } from '@convex/lib/providerOrder';
import {
	vAgentQuestionStatus,
	vAskQuestionAnswer,
	vAskQuestionOption,
	vCompletionProvider,
	vStoredExecutorJobKind,
	vExecutorJobPayload,
	vExecutorJobResult,
	vExecutorJobStatus,
	vLegacyArtifactType,
	vLinkedPullRequest,
	vModelCallUsage,
	vPurchaseStatus,
	vReasoningEffort,
	vRunFailureKind,
	vRunStatus,
	vTokenUsageTotals,
	vBillingInterval,
	vSubscriptionStatus,
	vTranscriptCompletionBody,
	vTranscriptPartKind,
	vTranscriptPromptBody,
	vTranscriptToolBody
} from '@convex/lib/validators';

export default defineSchema({
	users: defineTable({
		subject: v.string(),
		tokenIdentifier: v.string(),
		email: v.string(),
		dodoCustomerId: v.optional(v.string()),
		// Operator-set tier id that overrides Dodo subscriptions.
		grantedTier: v.optional(v.string())
	})
		.index('by_subject', ['subject'])
		.index('by_dodoCustomerId', ['dodoCustomerId']),
	machines: defineTable({
		userId: v.string(),
		machineId: v.string(),
		friendlyName: v.string(),
		platform: v.string(),
		platformVersion: v.string(),
		architecture: v.string(),
		hostname: v.string(),
		appVersion: v.string(),
		processId: v.string(),
		lastSeenAt: v.optional(v.number()),
		runIds: v.array(v.id('runs')),
		updatedAt: v.number()
	}).index('by_userId_and_machineId', ['userId', 'machineId']),
	tiers: defineTable({
		tierId: v.string(),
		label: v.string(),
		monthly: v.number(),
		description: v.optional(v.string()),
		features: v.optional(v.array(v.string())),
		displayOrder: v.optional(v.number()),
		highlighted: v.optional(v.boolean()),
		monthlyProductId: v.optional(v.string()),
		annualProductId: v.optional(v.string()),
		monthlyPrice: v.optional(vPrice),
		annualPrice: v.optional(vPrice)
	})
		.index('by_tierId', ['tierId'])
		.index('by_monthlyProductId', ['monthlyProductId'])
		.index('by_annualProductId', ['annualProductId']),
	billingCheckoutSessions: defineTable(v.any()),
	billingCheckoutAttempts: defineTable(v.any()),
	dodoPricingCache: defineTable(v.any()),
	subscriptionReconciliations: defineTable(v.any()),
	// Mirror of Dodo subscriptions; Dodo is the source of truth.
	subscriptions: defineTable({
		userId: v.string(),
		dodoSubscriptionId: v.optional(v.string()),
		dodoProductId: v.optional(v.string()),
		status: vSubscriptionStatus,
		billingPeriodStart: v.optional(v.number()),
		billingPeriodEnd: v.optional(v.number()),
		cancelAtNextBillingDate: v.optional(v.boolean()),
		syncedAt: v.optional(v.number()),
		quotaResetAt: v.optional(v.number()),
		tier: v.optional(v.string()),
		eventAt: v.optional(v.number()),
		projectionRevision: v.optional(v.number()),
		observedAt: v.optional(v.number()),
		providerStatus: v.optional(v.string()),
		scheduleEventAt: v.optional(v.number()),
		checkoutAttemptId: v.optional(v.string()),
		accessPhase: v.optional(v.string()),
		accessEndsAt: v.optional(v.number()),
		scheduledChange: v.optional(
			v.object({
				id: v.string(),
				productId: v.string(),
				effectiveAt: v.number()
			})
		),
		payloadEventAt: v.optional(v.number()),
		termEventAt: v.optional(v.number()),
		billingInterval: v.optional(vBillingInterval),
		billingPeriodCheckId: v.optional(v.id('_scheduled_functions')),
		quotaGeneration: v.optional(v.number()),
		quotaTransitionAt: v.optional(v.number()),
		terminalConfirmed: v.optional(v.boolean())
	})
		.index('by_userId', ['userId'])
		.index('by_dodoSubscriptionId', ['dodoSubscriptionId'])
		.index('by_status_and_billingPeriodEnd', ['status', 'billingPeriodEnd']),
	supersededSubscriptions: defineTable(v.any()),
	usage: defineTable({
		userId: v.string(),
		windowStart: v.number(),
		used: v.number()
	}).index('by_userId_and_windowStart', ['userId', 'windowStart']),
	dodoWebhookEvents: defineTable({
		seq: v.number(),
		environment: v.string(),
		webhookId: v.string(),
		eventType: v.string(),
		eventAt: v.optional(v.number()),
		receivedAt: v.number(),
		subscriptionId: v.optional(v.string()),
		productId: v.optional(v.string()),
		customerId: v.optional(v.string()),
		payload: v.optional(v.string()),
		attempts: v.number(),
		duplicateCount: v.optional(v.number()),
		nextAttemptAt: v.optional(v.number()),
		outcome: v.union(
			v.literal('pending'),
			v.literal('applied'),
			v.literal('stale'),
			v.literal('noop'),
			v.literal('unsupported'),
			v.literal('unresolved'),
			v.literal('competing'),
			v.literal('failed')
		),
		outcomeDetail: v.optional(v.string()),
		processedAt: v.optional(v.number()),
		workId: v.optional(vWorkId)
	})
		.index('by_seq', ['seq'])
		.index('by_environment_and_webhookId', ['environment', 'webhookId'])
		.index('by_outcome_and_nextAttemptAt', ['outcome', 'nextAttemptAt'])
		.index('by_receivedAt', ['receivedAt']),
	uiPreferences: defineTable({
		userId: v.string(),
		theme: v.union(v.literal('light'), v.literal('dark')),
		automaticThreadTitles: v.optional(v.boolean()),
		automaticAgentContinuation: v.optional(v.boolean()),
		settleMergedThreads: v.optional(v.boolean()),
		providerOrder: v.optional(v.array(vProviderOrderEntry)),
		restrictSubagentsToProvider: v.optional(v.boolean()),
		shareConversationContent: v.optional(v.boolean())
	}).index('by_userId', ['userId']),
	migrationSchedules: defineTable({
		name: v.string(),
		notBefore: v.number(),
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number())
	}).index('by_name', ['name']),
	threadRecords: defineTable({
		userId: v.string(),
		parentThreadId: v.optional(v.id('threadRecords')),
		status: vRunStatus,
		repositoryKey: v.string(),
		title: v.optional(v.string()),
		titleRenameKey: v.optional(v.string()),
		selectedModel: v.string(),
		completionProvider: v.optional(vCompletionProvider),
		reasoningEffort: vReasoningEffort,
		fastMode: v.boolean(),
		contextSummary: v.optional(v.string()),
		contextSummaryPartCount: v.optional(v.number()),
		contextSummaryThroughPartNumber: v.optional(v.number()),
		contextSummaryHandoffKey: v.optional(v.string()),
		reasoningStrippedThroughPartNumber: v.optional(v.number()),
		cwd: v.optional(v.string()),
		pullRequests: v.optional(v.array(vLinkedPullRequest)),
		lastMessageAt: v.number(),
		archivedAt: v.optional(v.number())
	})
		.index('by_userId_lastMessageAt', ['userId', 'lastMessageAt'])
		// oxlint-disable-next-line @convex-dev/no-duplicate-indexes -- Tree cancellation needs stable cursors while lastMessageAt changes.
		.index('by_userId_parentThreadId', ['userId', 'parentThreadId'])
		.index('by_userId_and_parentThreadId_and_lastMessageAt', [
			'userId',
			'parentThreadId',
			'lastMessageAt'
		])
		.index('by_userId_parentThreadId_repositoryKey_archivedAt_lastMessageAt', [
			'userId',
			'parentThreadId',
			'repositoryKey',
			'archivedAt',
			'lastMessageAt'
		]),
	threadHierarchyStates: defineTable({
		threadId: v.id('threadRecords'),
		workingDescendantCount: v.number(),
		descendantCount: v.number(),
		activeDescendantCount: v.number()
	}).index('by_threadId', ['threadId']),

	threadUsage: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		contextTokens: v.optional(v.number())
	}).index('by_threadId', ['threadId']),
	modelCallUsage: defineTable({
		userId: v.string(),
		runId: v.id('runs'),
		eventId: v.string(),
		...vModelCallUsage.fields
	}).index('by_runId_eventId', ['runId', 'eventId']),
	threadTokenUsage: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		...vTokenUsageTotals.fields
	}).index('by_threadId_model', ['threadId', 'provider', 'model', 'serviceTier', 'cacheWriteTtl']),
	userTokenUsage: defineTable({
		userId: v.string(),
		granularity: v.union(v.literal('hour'), v.literal('day')),
		bucketStart: v.number(),
		...vTokenUsageTotals.fields
	})
		.index('by_userId_bucket', [
			'userId',
			'granularity',
			'bucketStart',
			'provider',
			'model',
			'serviceTier',
			'cacheWriteTtl'
		])
		.index('by_granularity_bucket', ['granularity', 'bucketStart']),
	runs: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		submissionId: v.string(),
		status: vRunStatus,
		executionSecretHash: v.string(),
		machineId: v.optional(v.string()),
		continuationOfRunId: v.optional(v.id('runs')),
		selectedModel: v.string(),
		completionProvider: v.optional(vCompletionProvider),
		reasoningEffort: vReasoningEffort,
		fastMode: v.boolean(),
		pendingPrompt: v.optional(vTranscriptPromptBody),
		agentVersion: v.optional(v.string()),
		completedAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		failureKind: v.optional(vRunFailureKind),
		taskDeadlineAt: v.optional(v.number()),
		cancellationRequestedAt: v.optional(v.number())
	})
		.index('by_threadId', ['threadId'])
		.index('by_executionSecretHash', ['executionSecretHash'])
		.index('by_userId_submissionId', ['userId', 'submissionId']),
	runExecutionStates: defineTable({
		runId: v.id('runs'),
		claimId: v.optional(v.string()),
		claimExpiresAt: v.optional(v.number()),
		completionAttemptSeq: v.number(),
		activeJobId: v.optional(v.id('executorJobs')),
		lifecycleCheckId: v.optional(v.id('_scheduled_functions')),
		lifecycleGeneration: v.optional(v.number()),
		terminalJobsReconciled: v.optional(v.boolean())
	}).index('by_runId', ['runId']),
	commandSessions: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		sessionId: v.string(),
		...commandSnapshot.fields,
		eventsBytes: v.number()
	}).index('by_threadId_and_sessionId', ['threadId', 'sessionId']),
	commandLogChunks: defineTable({
		commandId: v.id('commandSessions'),
		offset: v.number(),
		bytes: v.bytes()
	}).index('by_commandId_offset', ['commandId', 'offset']),
	// Durable numbered transcript replica source. Kept off threadRecords so
	// appends do not invalidate the thread list subscription.
	threadTranscriptStates: defineTable({
		threadId: v.id('threadRecords'),
		totalParts: v.number()
	}).index('by_threadId', ['threadId']),
	threadTranscriptParts: defineTable({
		threadId: v.id('threadRecords'),
		number: v.number(),
		sourceKey: v.string(),
		kind: vTranscriptPartKind,
		runId: v.id('runs'),
		prompt: v.optional(vTranscriptPromptBody),
		completion: v.optional(vTranscriptCompletionBody),
		tool: v.optional(vTranscriptToolBody),
		work: workMembership
	})
		.index('by_threadId_and_number', ['threadId', 'number'])
		.index('by_threadId_kind_number', ['threadId', 'kind', 'number'])
		.index('by_threadId_and_sourceKey', ['threadId', 'sourceKey'])
		.index('by_threadId_and_runId_and_number', ['threadId', 'runId', 'number']),
	threadTranscriptWorkSections: defineTable({
		threadId: v.id('threadRecords'),
		...workSectionFields,
		sectionOrdinal: v.number(),
		displayOrder: v.string()
	})
		.index('by_threadId_and_key', ['threadId', 'key'])
		.index('by_threadId_and_sectionOrdinal', ['threadId', 'sectionOrdinal'])
		.index('by_threadId_and_displayOrder', ['threadId', 'displayOrder']),
	threadTranscriptMemberships: defineTable({
		threadId: v.id('threadRecords'),
		entryKey: v.string(),
		sectionKey: v.string(),
		runId: v.id('runs'),
		partNumber: v.number(),
		start: v.number(),
		end: v.number(),
		toolInvocationId: v.optional(v.string()),
		sectionOrdinal: v.number(),
		closed: v.boolean()
	})
		.index('by_threadId_and_entryKey', ['threadId', 'entryKey'])
		.index('by_threadId_sectionKey_partNumber_start', [
			'threadId',
			'sectionKey',
			'partNumber',
			'start'
		]),
	imageUploads: defineTable({
		userId: v.string(),
		storageId: v.id('_storage'),
		name: v.string(),
		mediaType: v.string(),
		size: v.number(),
		attached: v.boolean(),
		threadId: v.optional(v.id('threadRecords')),
		storageDeletedAt: v.optional(v.number()),
		sha256: v.optional(v.string())
	})
		.index('by_userId', ['userId'])
		.index('by_storageId', ['storageId'])
		.index('by_attached_and_storageDeletedAt', ['attached', 'storageDeletedAt'])
		.index('by_threadId_and_sha256_and_storageDeletedAt', [
			'threadId',
			'sha256',
			'storageDeletedAt'
		]),
	hostedParseRequests: defineTable({
		jobId: v.id('executorJobs'),
		runId: v.id('runs'),
		userId: v.string(),
		claimId: v.string(),
		status: v.union(
			v.literal('awaiting_upload'),
			v.literal('pending'),
			v.literal('completed'),
			v.literal('failed')
		),
		uploadUrl: v.optional(v.string()),
		inputStorageId: v.optional(v.id('_storage')),
		resultStorageId: v.optional(v.id('_storage')),
		filename: v.optional(v.string()),
		/** The result is `{"pages":[{pageNumber, markdown}]}` JSON instead of markdown. */
		pages: v.optional(v.boolean()),
		error: v.optional(v.string()),
		expiresAt: v.number()
	})
		.index('by_jobId', ['jobId'])
		.index('by_inputStorageId', ['inputStorageId'])
		.index('by_resultStorageId', ['resultStorageId'])
		.index('by_expiresAt', ['expiresAt']),
	webRequests: defineTable({
		runId: v.id('runs'),
		claimId: v.string(),
		jobId: v.id('executorJobs'),
		kind: v.literal('scrape'),
		rawDocument: v.optional(v.boolean()),
		status: v.union(
			v.literal('queued'),
			v.literal('running'),
			v.literal('completed'),
			v.literal('failed')
		),
		workId: v.optional(vWorkId),
		resultStorageId: v.optional(v.id('_storage')),
		error: v.optional(v.string()),
		expiresAt: v.number()
	}).index('by_runId', ['runId']),
	executorJobs: defineTable({
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		kind: vStoredExecutorJobKind,
		callId: v.optional(v.string()),
		toolInvocationId: v.string(),
		sectionKey: v.optional(v.string()),
		sectionOrdinal: v.optional(v.number()),
		attemptSeq: v.optional(v.number()),
		streamId: v.optional(v.string()),
		payload: vExecutorJobPayload,
		hidden: v.optional(v.boolean()),
		status: vExecutorJobStatus,
		enqueuedAt: v.number(),
		claimedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		result: v.optional(vExecutorJobResult),
		error: v.optional(v.string()),
		sequence: v.number(),
		cloudWorkId: v.optional(vWorkId)
	})
		.index('by_threadId_sequence', ['threadId', 'sequence'])
		.index('by_runId_sequence', ['runId', 'sequence'])
		.index('by_runId_and_toolInvocationId', ['runId', 'toolInvocationId'])
		.index('by_runId_and_callId', ['runId', 'callId']),
	agentQuestions: defineTable({
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		jobId: v.id('executorJobs'),
		question: v.string(),
		options: v.array(vAskQuestionOption),
		status: vAgentQuestionStatus,
		answer: v.optional(vAskQuestionAnswer),
		requiresContinuation: v.optional(v.boolean()),
		continuationClaim: v.optional(
			v.object({
				toolJobId: v.id('executorJobs'),
				claimId: v.string()
			})
		),
		timeoutAt: v.optional(v.number()),
		answeredAt: v.optional(v.number()),
		sequence: v.number()
	})
		.index('by_runId_sequence', ['runId', 'sequence'])
		.index('by_threadId_sequence', ['threadId', 'sequence'])
		.index('by_threadId_status_sequence', ['threadId', 'status', 'sequence']),
	artifactRegistries: defineTable({
		userId: v.string(),
		repositoryKey: v.string(),
		revision: v.number()
	}).index('by_userId_and_repositoryKey', ['userId', 'repositoryKey']),
	artifacts: defineTable({
		userId: v.string(),
		scope: v.literal('project'),
		repositoryKey: v.string(),
		registrationId: v.string(),
		content: v.string(),
		// Dropped by migrations:removeArtifactTypes.
		type: v.optional(vLegacyArtifactType),
		title: v.string(),
		revision: v.number(),
		updatedAt: v.number()
	})
		.index('by_userId_and_registrationId', ['userId', 'registrationId'])
		.index('by_userId_and_repositoryKey_and_scope', ['userId', 'repositoryKey', 'scope']),
	mandates: defineTable(v.any()),
	mandateCharges: defineTable(v.any()),
	agentcardUsers: defineTable({
		userId: v.string(),
		agentcardUserId: v.string()
	}).index('by_userId', ['userId']),
	// One cached platform token; Agentcard rate-limits token exchanges per IP.
	agentcardTokens: defineTable({
		clientId: v.string(),
		accessToken: v.string(),
		expiresAt: v.number()
	}),
	purchases: defineTable({
		userId: v.string(),
		threadId: v.id('threadRecords'),
		attemptId: v.string(),
		authorizationId: v.string(),
		merchant: v.string(),
		// Smallest currency unit, as Agentcard reports it.
		amount: v.number(),
		currency: v.string(),
		status: vPurchaseStatus,
		// Absent while Agentcard pays without asking, under a user's auto-approval.
		approvalUrl: v.optional(v.string()),
		orderNumber: v.optional(v.string()),
		orderLink: v.optional(v.string()),
		trackingLink: v.optional(v.string())
	})
		.index('by_userId', ['userId'])
		.index('by_threadId_status', ['threadId', 'status'])
		.index('by_authorizationId', ['authorizationId'])
		.index('by_attemptId', ['attemptId'])
});
