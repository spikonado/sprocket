import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { vDodoPublicPrice } from '@convex/lib/dodoProducts';
import { vTierPrice } from '@convex/lib/pricingValidators';
import { workPosition, workSectionFields, workMembership } from '@convex/lib/workSections';
import { commandSnapshot } from '@convex/lib/commandSessions';
import {
	vMandateChargeStatus,
	vMandateFrequency,
	vMandateReportOutcome,
	vMandateScope,
	vMandateStatus
} from '@convex/lib/validators';
import {
	vAgentQuestionStatus,
	vArtifactScope,
	vArtifactType,
	vAskQuestionAnswer,
	vAskQuestionOption,
	vCompletionProvider,
	vDescendantStatusCounts,
	vStoredExecutorJobKind,
	vExecutorJobPayload,
	vExecutorJobResult,
	vExecutorJobStatus,
	vReasoningEffort,
	vRunStatus,
	vBillingInterval,
	vSubscriptionStatus,
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
	machines: defineTable({
		userId: v.string(),
		machineId: v.string(),
		friendlyName: v.string(),
		platform: v.string(),
		platformVersion: v.string(),
		architecture: v.string(),
		hostname: v.string(),
		appVersion: v.string(),
		credentialHash: v.string(),
		lastSeenAt: v.optional(v.number()),
		runIds: v.array(v.id('runs')),
		createdAt: v.number(),
		updatedAt: v.number()
	}).index('by_userId_and_machineId', ['userId', 'machineId']),
	// Operator-managed subscription tiers (edited directly in prod data).
	// The rate limiter reads weekly/monthly quota units from these rows.
	tiers: defineTable({
		tierId: v.string(),
		label: v.string(),
		weekly: v.number(),
		monthly: v.number(),
		description: v.optional(v.string()),
		features: v.optional(v.array(v.string())),
		displayOrder: v.optional(v.number()),
		highlighted: v.optional(v.boolean()),
		monthlyProductId: v.optional(v.string()),
		annualProductId: v.optional(v.string())
	})
		.index('by_tierId', ['tierId'])
		.index('by_monthlyProductId', ['monthlyProductId'])
		.index('by_annualProductId', ['annualProductId']),
	billingCustomers: defineTable({
		userId: v.string(),
		dodoCustomerId: v.string(),
		// Provider environment the customer was created in. Legacy rows lack it;
		// checkout rejects them when the current environment differs.
		dodoEnvironment: v.optional(v.string())
	})
		.index('by_userId', ['userId'])
		.index('by_dodoCustomerId', ['dodoCustomerId']),
	billingCheckoutSessions: defineTable({
		userId: v.string(),
		attemptId: v.string(),
		tierId: v.string(),
		interval: vBillingInterval,
		productId: v.string(),
		checkoutUrl: v.optional(v.string()),
		dodoSessionId: v.optional(v.string()),
		// Idempotency key for the provider create call. Attempts created before
		// this field existed minted no key, so it is absent on legacy rows.
		idempotencyKey: v.optional(v.string()),
		outcome: v.optional(
			v.union(
				v.literal('reserved'),
				v.literal('created'),
				v.literal('create_ambiguous'),
				v.literal('recovered'),
				v.literal('paid'),
				v.literal('failed')
			)
		),
		// Wall time of the last outcome transition; retry pacing reads this
		// instead of inferring it from expiresAt.
		outcomeUpdatedAt: v.optional(v.number()),
		createStartedAt: v.optional(v.number()),
		// Frozen provider create body for an ambiguous attempt: retries must
		// reissue byte-identical parameters under the same idempotency key.
		createRequest: v.optional(
			v.object({
				productId: v.string(),
				returnUrl: v.string(),
				cancelUrl: v.string(),
				dodoCustomerId: v.string()
			})
		),
		dodoEnvironment: v.optional(v.string()),
		expiresAt: v.number()
	})
		// eslint-disable-next-line @convex-dev/no-duplicate-indexes -- Released readers use this index; retain until their removal gate passes.
		.index('by_userId', ['userId'])
		.index('by_userId_and_attemptId', ['userId', 'attemptId'])
		.index('by_userId_and_dodoSessionId', ['userId', 'dodoSessionId']),
	// Older checkout attempts kept after a selection change so their provider
	// idempotency keys survive and already-created links stay payable.
	billingCheckoutAttempts: defineTable({
		userId: v.string(),
		attemptId: v.string(),
		tierId: v.string(),
		interval: vBillingInterval,
		productId: v.string(),
		checkoutUrl: v.optional(v.string()),
		dodoSessionId: v.optional(v.string()),
		idempotencyKey: v.optional(v.string()),
		outcome: v.optional(v.string()),
		outcomeUpdatedAt: v.optional(v.number()),
		createStartedAt: v.optional(v.number()),
		createRequest: v.optional(
			v.object({
				productId: v.string(),
				returnUrl: v.string(),
				cancelUrl: v.string(),
				dodoCustomerId: v.string()
			})
		),
		dodoEnvironment: v.optional(v.string()),
		expiresAt: v.number()
	})
		// eslint-disable-next-line @convex-dev/no-duplicate-indexes -- Checkout history readers require creation-order iteration.
		.index('by_userId', ['userId'])
		.index('by_userId_and_attemptId', ['userId', 'attemptId'])
		.index('by_userId_and_dodoSessionId', ['userId', 'dodoSessionId']),
	dodoPricingCache: defineTable({
		// One row per provider environment + product id. Legacy rows key an
		// entire tier set under cacheKey; new rows set environment/productId.
		cacheKey: v.string(),
		environment: v.optional(v.string()),
		productId: v.optional(v.string()),
		tierPrices: v.optional(v.array(vTierPrice)),
		price: v.optional(vDodoPublicPrice),
		// Set on rows whose last refresh failed: transient errors retry after
		// retryAt; definitive failures (missing/invalid/ambiguous) hold the
		// null price until expiresAt.
		refreshFailed: v.optional(v.boolean()),
		retryAt: v.optional(v.number()),
		// Wall time the cached price was last confirmed by the provider. Stale
		// display is bounded from this, never from retry deadlines, so repeated
		// transient failures cannot extend display indefinitely.
		validatedAt: v.optional(v.number()),
		leaseOwner: v.optional(v.string()),
		leaseExpiresAt: v.optional(v.number()),
		expiresAt: v.number()
	})
		.index('by_cacheKey', ['cacheKey'])
		.index('by_environment_and_productId', ['environment', 'productId'])
		.index('by_environment_and_leaseExpiresAt', ['environment', 'leaseExpiresAt']),
	subscriptionReconciliations: defineTable({
		subscriptionId: v.id('subscriptions'),
		dodoSubscriptionId: v.string(),
		projectionRevision: v.number(),
		attempt: v.number(),
		accessPhase: v.string(),
		workId: v.string(),
		state: v.union(v.literal('pending'), v.literal('completed'), v.literal('exhausted')),
		updatedAt: v.number()
	}).index('by_subscriptionId', ['subscriptionId']),
	subscriptions: defineTable({
		userId: v.string(),
		// Operator-managed tier id (see the `tiers` table).
		tier: v.string(),
		status: vSubscriptionStatus,
		eventAt: v.number(),
		// Monotonic per-subscription projection revision. Scheduled expiry
		// checks and reconciliation fetches fence on it so stale results
		// cannot overwrite a newer projection.
		projectionRevision: v.optional(v.number()),
		observedAt: v.optional(v.number()),
		providerStatus: v.optional(v.string()),
		scheduleEventAt: v.optional(v.number()),
		checkoutAttemptId: v.optional(v.string()),
		// Paid-access phase and the wall-clock deadline it ends at. The expiry
		// scheduler advances it; enforcement re-checks `accessEndsAt` so a
		// delayed scheduler cannot extend access. Undefined rows predate the
		// field and behave like 'paid'/'none' per subscriptionIsActive.
		accessPhase: v.optional(
			v.union(v.literal('paid'), v.literal('renewal_processing'), v.literal('none'))
		),
		accessEndsAt: v.optional(v.number()),
		// Pending provider-scheduled product change. Kept separate from the
		// effective tier and applied only once provider state confirms it.
		scheduledChange: v.optional(
			v.object({
				id: v.string(),
				productId: v.string(),
				effectiveAt: v.number()
			})
		),
		// Distinct ordering watermark for product/term payloads. Status
		// transitions fence on `eventAt`; payload (tier/term/scheduled change)
		// transitions fence on this.
		payloadEventAt: v.optional(v.number()),
		// Paid-term confirmations fence on their own watermark so a historical
		// failure cannot override a newer successful term.
		termEventAt: v.optional(v.number()),
		billingInterval: v.optional(vBillingInterval),
		billingPeriodStart: v.optional(v.number()),
		billingPeriodEnd: v.optional(v.number()),
		billingPeriodEnded: v.optional(v.boolean()),
		billingPeriodCheckId: v.optional(v.id('_scheduled_functions')),
		cancelAtNextBillingDate: v.optional(v.boolean()),
		// Retained as the bucket key until released timestamp-keyed gateways
		// age out and consumed buckets are migrated to counter-only keys.
		quotaResetAt: v.optional(v.number()),
		// Durable transition counter; released meters still key on quotaResetAt.
		quotaGeneration: v.optional(v.number()),
		// Provider event time of the latest usage-generation transition. A
		// redelivered or older plan-change event never mints a second
		// generation for the same change.
		quotaTransitionAt: v.optional(v.number()),
		// Set by the projection once the provider state is authoritatively
		// terminal (cancelled/expired past term, non-recoverable). Purchase
		// eligibility reads this: only terminal rows unblock a new purchase.
		terminalConfirmed: v.optional(v.boolean()),
		dodoSubscriptionId: v.optional(v.string()),
		dodoProductId: v.optional(v.string())
	})
		.index('by_userId', ['userId'])
		.index('by_dodoSubscriptionId', ['dodoSubscriptionId']),
	// Provider subscriptions that once held the projection slot. Events from
	// these identities must not reclaim the current projection.
	supersededSubscriptions: defineTable({
		userId: v.string(),
		dodoSubscriptionId: v.string(),
		supersededAt: v.number()
	})
		.index('by_userId', ['userId'])
		.index('by_dodoSubscriptionId', ['dodoSubscriptionId']),
	// Verified Dodo webhook events. One row per (environment, webhook-id);
	// deduplication and replay both go through this ledger.
	dodoWebhookEvents: defineTable({
		// Monotonic ingestion sequence, separate from receivedAt so cleanup
		// cursors never starve behind same-receiptAt inserts.
		seq: v.optional(v.number()),
		environment: v.string(),
		webhookId: v.string(),
		eventType: v.string(),
		// Provider event time; `receivedAt` is local receipt time.
		eventAt: v.optional(v.number()),
		receivedAt: v.number(),
		subscriptionId: v.optional(v.string()),
		productId: v.optional(v.string()),
		customerId: v.optional(v.string()),
		// Sanitized payload kept for replay; dropped by retention cleanup
		// while identity/outcome fields persist for dedup.
		payload: v.optional(v.string()),
		attempts: v.number(),
		// Duplicate deliveries after the first persisted record. The original
		// processing outcome is never overwritten by a duplicate.
		duplicateCount: v.optional(v.number()),
		nextAttemptAt: v.optional(v.number()),
		outcome: v.union(
			v.literal('pending'),
			v.literal('applied'),
			v.literal('duplicate'),
			v.literal('stale'),
			v.literal('noop'),
			v.literal('unsupported'),
			v.literal('unresolved'),
			v.literal('competing'),
			v.literal('failed')
		),
		outcomeDetail: v.optional(v.string()),
		processedAt: v.optional(v.number()),
		// Workpool work id of the currently queued processing run.
		workId: v.optional(v.string())
	})
		.index('by_seq', ['seq'])
		.index('by_environment_and_webhookId', ['environment', 'webhookId'])
		.index('by_outcome_and_nextAttemptAt', ['outcome', 'nextAttemptAt'])
		.index('by_receivedAt', ['receivedAt']),
	// Singleton bookkeeping for bounded ledger retention: the cleanup cursor
	// prevents rescanning the newest rows and starving the older remainder.
	dodoWebhookCleanup: defineTable({
		key: v.string(),
		cursor: v.number()
	}).index('by_key', ['key']),
	uiPreferences: defineTable({
		userId: v.string(),
		theme: v.union(v.literal('light'), v.literal('dark')),
		automaticThreadTitles: v.optional(v.boolean())
	}).index('by_userId', ['userId']),
	providerCredentialStates: defineTable({
		userId: v.string(),
		connectionId: v.optional(v.string()),
		modelIds: v.optional(v.array(v.string())),
		browserLogin: v.optional(
			v.object({ hash: v.string(), codeVerifier: v.string(), expiresAt: v.number() })
		),
		deviceLogin: v.optional(v.object({ hash: v.string(), expiresAt: v.number() })),
		completedLogin: v.optional(
			v.object({ flow: v.union(v.literal('browser'), v.literal('device')), hash: v.string() })
		),
		lease: v.optional(v.object({ id: v.string(), expiresAt: v.number() }))
	}).index('by_userId', ['userId']),
	migrationSchedules: defineTable({
		name: v.string(),
		notBefore: v.number(),
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number())
	}).index('by_name', ['name']),
	threadRecords: defineTable({
		userId: v.string(),
		submissionId: v.string(),
		parentThreadId: v.optional(v.id('threadRecords')),
		status: vRunStatus,
		repositoryKey: v.string(),
		title: v.optional(v.string()),
		selectedModel: v.string(),
		completionProvider: v.optional(vCompletionProvider),
		reasoningEffort: vReasoningEffort,
		fastMode: v.boolean(),
		contextSummary: v.optional(v.string()),
		// Inclusive last covered part. -1 means the handoff covers an empty prefix.
		contextSummaryThroughPartNumber: v.optional(v.number()),
		// runId:claimId:attemptSeq that wrote the current part-number cutoff.
		contextSummaryHandoffKey: v.optional(v.string()),
		lastMessageAt: v.number(),
		archivedAt: v.optional(v.number())
	})
		.index('by_userId_submissionId', ['userId', 'submissionId'])
		.index('by_userId_lastMessageAt', ['userId', 'lastMessageAt'])
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
		// Released contribution flags are accepted only until the counter backfill finishes.
		ownActive: v.optional(v.boolean()),
		ownStatus: v.optional(vRunStatus),
		workingDescendantCount: v.optional(v.number()),
		descendantCount: v.number(),
		activeDescendantCount: v.number(),
		descendantStatusCounts: v.optional(vDescendantStatusCounts)
	}).index('by_threadId', ['threadId']),

	threadUsage: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		contextTokens: v.optional(v.number())
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
		status: vRunStatus,
		// Hash of the bearer capability held only by the local executor.
		executionSecretHash: v.string(),
		machineId: v.optional(v.string()),
		continuationOfRunId: v.optional(v.id('runs')),
		selectedModel: v.string(),
		completionProvider: v.optional(vCompletionProvider),
		reasoningEffort: vReasoningEffort,
		fastMode: v.boolean(),
		gatewayProtocolVersion: v.optional(v.number()),
		agentVersion: v.optional(v.string()),
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		cancellationRequestedAt: v.optional(v.number()),
		cancellationDeadlineAt: v.optional(v.number())
	})
		.index('by_threadId_startedAt', ['threadId', 'startedAt'])
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
		userId: v.string(),
		totalParts: v.number(),
		workThrough: v.optional(workPosition)
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
		displayOrder: v.string(),
		// Cleared by removeSectionLinkedParts; drop once that backfill finishes.
		linkedParts: v.optional(v.number())
	})
		.index('by_threadId_and_key', ['threadId', 'key'])
		.index('by_threadId_and_sectionOrdinal', ['threadId', 'sectionOrdinal'])
		.index('by_threadId_and_displayOrder', ['threadId', 'displayOrder']),
	threadTranscriptMemberships: defineTable({
		threadId: v.id('threadRecords'),
		// Entry rows written by current section writes; legacy membership rows
		// are gone after the completed write-time migration.
		number: v.optional(v.number()),
		work: v.optional(workMembership),
		entryKey: v.optional(v.string()),
		sectionKey: v.optional(v.string()),
		runId: v.optional(v.id('runs')),
		partNumber: v.optional(v.number()),
		start: v.optional(v.number()),
		end: v.optional(v.number()),
		toolInvocationId: v.optional(v.string()),
		sectionOrdinal: v.optional(v.number()),
		closed: v.optional(v.boolean())
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
		storageDeletedAt: v.optional(v.number())
	})
		.index('by_userId', ['userId'])
		.index('by_storageId', ['storageId'])
		.index('by_attached_and_storageDeletedAt', ['attached', 'storageDeletedAt']),
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
		error: v.optional(v.string()),
		expiresAt: v.number()
	})
		.index('by_jobId', ['jobId'])
		.index('by_inputStorageId', ['inputStorageId'])
		.index('by_resultStorageId', ['resultStorageId'])
		.index('by_expiresAt', ['expiresAt']),
	firecrawlRequests: defineTable({
		runId: v.id('runs'),
		claimId: v.string(),
		jobId: v.optional(v.id('executorJobs')),
		kind: v.union(v.literal('scrape'), v.literal('screenshot')),
		status: v.union(
			v.literal('queued'),
			v.literal('running'),
			v.literal('completed'),
			v.literal('failed')
		),
		workId: v.optional(v.string()),
		resultStorageId: v.optional(v.id('_storage')),
		error: v.optional(v.string()),
		expiresAt: v.number()
	}).index('by_runId', ['runId']),
	executorJobs: defineTable({
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		kind: vStoredExecutorJobKind,
		callId: v.optional(v.string()),
		// Set on jobs created after tool progress events. Older rows omit it;
		// transcript writes fall back to the job document id.
		toolInvocationId: v.optional(v.string()),
		sectionKey: v.optional(v.string()),
		sectionOrdinal: v.optional(v.number()),
		attemptSeq: v.optional(v.number()),
		streamId: v.optional(v.string()),
		payload: vExecutorJobPayload,
		// Historical rows only. New jobs have no visibility flag.
		hidden: v.optional(v.boolean()),
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
		createdAt: v.number(),
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
		revision: v.number(),
		rekeyTo: v.optional(v.string())
	}).index('by_userId_and_repositoryKey', ['userId', 'repositoryKey']),
	artifacts: defineTable({
		userId: v.string(),
		scope: vArtifactScope,
		repositoryKey: v.string(),
		// Legacy thread confinement; current writes omit this field and migrations remove it.
		threadId: v.optional(v.id('threadRecords')),
		registrationId: v.string(),
		content: v.string(),
		type: vArtifactType,
		title: v.string(),
		revision: v.number(),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_userId_and_registrationId', ['userId', 'registrationId'])
		.index('by_userId_and_repositoryKey_and_scope', ['userId', 'repositoryKey', 'scope']),
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
		.index('by_reportRetrierRunId', ['reportRetrierRunId'])
});
