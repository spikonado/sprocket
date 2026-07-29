import { defineSchema, defineTable } from 'convex/server';
import {
	agentQuestionFields,
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
		.index('by_threadId_status_sequence', ['threadId', 'status', 'sequence'])
});
