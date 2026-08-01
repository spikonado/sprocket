import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	agentQuestionFields,
	artifactFields,
	artifactVersionFields,
	billingCustomerFields,
	completionStreamStateFields,
	executorJobFields,
	imageUploadFields,
	projectFields,
	runFields,
	subscriptionFields,
	threadMessageFields,
	threadRecordFields,
	uiPreferencesFields
} from '@convex/lib/docs';
import {
	vMandateChargeStatus,
	vMandateFrequency,
	vMandateReportOutcome,
	vMandateScope,
	vMandateStatus
} from '@convex/lib/validators';

export default defineSchema({
	billingCustomers: defineTable(billingCustomerFields).index('by_userId', ['userId']),
	subscriptions: defineTable(subscriptionFields).index('by_userId', ['userId']),
	uiPreferences: defineTable(uiPreferencesFields).index('by_userId', ['userId']),
	projects: defineTable(projectFields)
		.index('by_userId', ['userId'])
		.index('by_userId_lastSeenAt', ['userId', 'lastSeenAt'])
		.index('by_user_repositoryKey', ['userId', 'repositoryKey']),
	threadRecords: defineTable(threadRecordFields)
		.index('by_userId_lastMessageAt', ['userId', 'lastMessageAt'])
		.index('by_userId_submissionId', ['userId', 'submissionId']),
	runs: defineTable(runFields)
		.index('by_threadId_startedAt', ['threadId', 'startedAt'])
		.index('by_threadId_status_startedAt', ['threadId', 'status', 'startedAt'])
		.index('by_executionSecretHash', ['executionSecretHash'])
		.index('by_userId_submissionId', ['userId', 'submissionId']),
	threadMessages: defineTable(threadMessageFields),
	completionStreamStates: defineTable(completionStreamStateFields),
	imageUploads: defineTable(imageUploadFields)
		.index('by_userId', ['userId'])
		.index('by_storageId', ['storageId'])
		.index('by_attached', ['attached']),
	executorJobs: defineTable(executorJobFields)
		.index('by_projectId_sequence', ['projectId', 'sequence'])
		.index('by_threadId_sequence', ['threadId', 'sequence'])
		.index('by_runId_sequence', ['runId', 'sequence'])
		.index('by_runId_hidden_sequence', ['runId', 'hidden', 'sequence']),
	agentQuestions: defineTable(agentQuestionFields)
		.index('by_runId_sequence', ['runId', 'sequence'])
		.index('by_threadId_sequence', ['threadId', 'sequence'])
		.index('by_threadId_status_sequence', ['threadId', 'status', 'sequence']),
	artifacts: defineTable(artifactFields)
		.index('by_threadId', ['threadId'])
		.index('by_threadId_title', ['threadId', 'title']),
	artifactVersions: defineTable(artifactVersionFields).index('by_artifactId_version', [
		'artifactId',
		'version'
	]),
	mandates: defineTable({
		userId: v.string(),
		pravaMandateId: v.optional(v.string()),
		pravaSessionId: v.optional(v.string()),
		merchantName: v.optional(v.string()),
		merchantUrl: v.optional(v.string()),
		countryCode: v.optional(v.string()),
		amountCap: v.string(),
		currency: v.string(),
		frequency: vMandateFrequency,
		scope: vMandateScope,
		status: vMandateStatus,
		approvalUrl: v.optional(v.string()),
		validUntil: v.optional(v.string()),
		renewsAt: v.optional(v.string()),
		remaining: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number()
	}),
	mandateCharges: defineTable({
		mandateId: v.id('mandates'),
		runId: v.id('runs'),
		userId: v.string(),
		pravaTransactionId: v.optional(v.string()),
		amount: v.string(),
		currency: v.string(),
		description: v.string(),
		reference: v.optional(v.string()),
		status: vMandateChargeStatus,
		reportOutcome: v.optional(vMandateReportOutcome),
		reportedAt: v.optional(v.number()),
		reportingStartedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number()
	}),
	browserSessions: defineTable({
		runId: v.id('runs'),
		userId: v.string(),
		browserbaseSessionId: v.string(),
		startedAt: v.number()
	}).index('by_run', ['runId'])
});
