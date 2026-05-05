import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	vExecutorJobKind,
	vExecutorJobPayload,
	vExecutorJobResult,
	vExecutorJobStatus,
	vExecutorStatus,
	vModelId,
	vReasoningEffort,
	vRunStatus,
	vThreadMessageRole,
	vThreadMessageStatus,
	vWorkspaceOverview
} from '@convex/lib/validators';

export default defineSchema({
	uiPreferences: defineTable({
		userId: v.string(),
		lastThreadId: v.optional(v.string())
	}).index('by_userId', ['userId']),
	workspaceSessions: defineTable({
		userId: v.string(),
		subject: v.optional(v.string()),
		email: v.optional(v.string()),
		name: v.optional(v.string()),
		workspacePath: v.string(),
		workspaceName: v.string(),
		workspaceOverview: vWorkspaceOverview,
		gitBranch: v.union(v.string(), v.null()),
		gitDirty: v.boolean(),
		executorStatus: vExecutorStatus,
		lastHeartbeatAt: v.optional(v.number()),
		connectedClientId: v.optional(v.string()),
		nextExecutorSequence: v.optional(v.number()),
		lastSeenAt: v.number()
	})
		.index('by_userId', ['userId'])
		.index('by_userId_lastSeenAt', ['userId', 'lastSeenAt'])
		.index('by_user_workspacePath', ['userId', 'workspacePath']),
	threadRecords: defineTable({
		userId: v.string(),
		threadId: v.string(),
		workspaceSessionId: v.id('workspaceSessions'),
		workspacePath: v.string(),
		workspaceName: v.optional(v.string()),
		title: v.optional(v.string()),
		summary: v.optional(v.string()),
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		nextMessageOrder: v.optional(v.number()),
		lastMessageAt: v.number()
	})
		.index('by_userId_lastMessageAt', ['userId', 'lastMessageAt'])
		.index('by_threadId', ['threadId'])
		.index('by_workspaceSessionId', ['workspaceSessionId']),
	runs: defineTable({
		threadId: v.string(),
		userId: v.string(),
		workspaceSessionId: v.id('workspaceSessions'),
		status: vRunStatus,
		selectedModel: vModelId,
		reasoningEffort: vReasoningEffort,
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
		activeJobId: v.optional(v.id('executorJobs')),
		promptMessageId: v.optional(v.id('threadMessages'))
	})
		.index('by_threadId_startedAt', ['threadId', 'startedAt'])
		.index('by_workspaceSessionId', ['workspaceSessionId'])
		.index('by_userId_startedAt', ['userId', 'startedAt']),
	threadMessages: defineTable({
		threadId: v.string(),
		runId: v.optional(v.id('runs')),
		role: vThreadMessageRole,
		status: vThreadMessageStatus,
		text: v.string(),
		order: v.number(),
		stepOrder: v.number(),
		agentName: v.optional(v.string()),
		createdAt: v.number(),
		completedAt: v.optional(v.number())
	})
		.index('by_threadId_order', ['threadId', 'order'])
		.index('by_runId', ['runId']),
	executorJobs: defineTable({
		workspaceSessionId: v.id('workspaceSessions'),
		threadId: v.string(),
		runId: v.id('runs'),
		kind: vExecutorJobKind,
		payload: vExecutorJobPayload,
		hidden: v.optional(v.boolean()),
		status: vExecutorJobStatus,
		enqueuedAt: v.number(),
		claimedBy: v.optional(v.string()),
		claimedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		result: v.optional(vExecutorJobResult),
		error: v.optional(v.string()),
		sequence: v.number()
	})
		.index('by_workspaceSessionId_sequence', ['workspaceSessionId', 'sequence'])
		.index('by_runId_sequence', ['runId', 'sequence'])
		.index('by_workspaceSessionId_status_sequence', ['workspaceSessionId', 'status', 'sequence'])
});
