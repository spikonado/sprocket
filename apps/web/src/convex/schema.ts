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
	purchases: defineTable({
		userId: v.string(),
		runId: v.id('runs'),
		pravaSessionId: v.string(),
		merchantName: v.string(),
		merchantUrl: v.string(),
		totalAmount: v.string(),
		currency: v.string(),
		description: v.string(),
		status: v.union(
			v.literal('awaiting_passkey'),
			v.literal('awaiting_result'),
			v.literal('spent'),
			v.literal('declined'),
			v.literal('failed'),
			v.literal('expired')
		),
		reportedAt: v.optional(v.number()),
		reportingStartedAt: v.optional(v.number()),
		reportOutcome: v.optional(v.union(v.literal('approved'), v.literal('declined'))),
		createdAt: v.number(),
		updatedAt: v.number()
	})
		.index('by_user', ['userId'])
		.index('by_run', ['runId'])
		.index('by_prava_session', ['pravaSessionId']),
	browserSessions: defineTable({
		runId: v.id('runs'),
		userId: v.string(),
		browserbaseSessionId: v.string(),
		liveViewUrl: v.string(),
		startedAt: v.number()
	}).index('by_run', ['runId'])
});
