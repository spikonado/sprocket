import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	vExecutorJobKind,
	vExecutorJobPayload,
	vExecutorJobResult,
	vExecutorJobStatus,
	vModelId,
	vReasoningEffort,
	vServiceTier,
	vRunStatus,
	vAssistantMessagePart,
	vThreadMessageType
} from '@convex/lib/validators';

export default defineSchema({
	uiPreferences: defineTable({
		userId: v.string(),
		lastThreadId: v.optional(v.id('threadRecords'))
	}).index('by_userId', ['userId']),
	workspaceSessions: defineTable({
		userId: v.string(),
		workspaceName: v.string(),
		lastHeartbeatAt: v.optional(v.number()),
		connectedClientId: v.optional(v.string()),
		nextExecutorSequence: v.number(),
		lastSeenAt: v.number()
	})
		.index('by_userId', ['userId'])
		.index('by_userId_lastSeenAt', ['userId', 'lastSeenAt'])
		.index('by_user_workspaceName', ['userId', 'workspaceName']),
	threadRecords: defineTable({
		userId: v.string(),
		submissionId: v.string(),
		workspaceSessionId: v.id('workspaceSessions'),
		title: v.optional(v.string()),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		lastMessageAt: v.number(),
		archivedAt: v.optional(v.number())
	})
		.index('by_userId_lastMessageAt', ['userId', 'lastMessageAt'])
		.index('by_userId_submissionId', ['userId', 'submissionId'])
		.index('by_workspaceSessionId', ['workspaceSessionId']),
	runs: defineTable({
		threadId: v.id('threadRecords'),
		userId: v.string(),
		submissionId: v.string(),
		workspaceSessionId: v.id('workspaceSessions'),
		status: vRunStatus,
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
		responseMessageId: v.optional(v.id('threadMessages'))
	})
		.index('by_threadId_startedAt', ['threadId', 'startedAt'])
		.index('by_userId_submissionId', ['userId', 'submissionId'])
		.index('by_workspaceSessionId', ['workspaceSessionId'])
		.index('by_userId_startedAt', ['userId', 'startedAt']),
	threadMessages: defineTable({
		threadId: v.id('threadRecords'),
		runId: v.id('runs'),
		userId: v.string(),
		type: vThreadMessageType,
		text: v.string(),
		imageUploadIds: v.optional(v.array(v.id('imageUploads'))),
		parts: v.optional(v.array(vAssistantMessagePart)),
		streamSequence: v.optional(v.number()),
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
		workspaceSessionId: v.id('workspaceSessions'),
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
		.index('by_workspaceSessionId_sequence', ['workspaceSessionId', 'sequence'])
		.index('by_threadId_sequence', ['threadId', 'sequence'])
		.index('by_runId_sequence', ['runId', 'sequence'])
});
