import { v, type Infer } from 'convex/values';
import { modelIds, reasoningEffortIds } from '@web-lib/models';

function literals<const TValues extends readonly string[]>(values: TValues) {
	return values.map((value) => v.literal(value)) as {
		[K in keyof TValues]: ReturnType<typeof v.literal<TValues[K]>>;
	};
}

export { modelIds, reasoningEffortIds };

export const vReasoningEffort = v.union(...literals(reasoningEffortIds));

export const vModelId = v.union(...literals(modelIds));

export const vWorkspaceEntry = v.object({
	name: v.string(),
	kind: v.string()
});

export const vWorkspaceOverview = v.object({
	rootPath: v.string(),
	name: v.string(),
	gitBranch: v.union(v.string(), v.null()),
	gitDirty: v.boolean(),
	fileCount: v.number(),
	directoryCount: v.number(),
	topLevelEntries: v.array(vWorkspaceEntry),
	recentFiles: v.array(v.string())
});

export const vWorkspaceInstruction = v.object({
	path: v.string(),
	directory: v.string(),
	contents: v.string(),
	truncated: v.boolean()
});

export const vReadFilePayload = v.object({
	path: v.string(),
	startLine: v.optional(v.number()),
	maxLines: v.optional(v.number())
});

export const vCreateFilePayload = v.object({
	path: v.string(),
	content: v.string()
});

export const vReplaceInFilePayload = v.object({
	path: v.string(),
	oldText: v.string(),
	newText: v.string(),
	replaceAll: v.optional(v.boolean())
});

export const vExecutorJobPayload = v.union(
	v.object({}),
	vReadFilePayload,
	vCreateFilePayload,
	vReplaceInFilePayload
);

export const vFileReadResult = v.object({
	path: v.string(),
	exists: v.optional(v.boolean()),
	startLine: v.number(),
	endLine: v.number(),
	totalLines: v.number(),
	truncated: v.boolean(),
	contents: v.string(),
	error: v.optional(v.string())
});

export const vFileWriteResult = v.object({
	path: v.string(),
	bytesWritten: v.number()
});

export const vFileEditResult = v.object({
	path: v.string(),
	replacements: v.number(),
	bytesWritten: v.number()
});

export const vExecutorJobResult = v.union(
	vWorkspaceOverview,
	v.array(vWorkspaceInstruction),
	vFileReadResult,
	vFileWriteResult,
	vFileEditResult
);

export const vExecutorStatus = v.union(v.literal('disconnected'), v.literal('connected'));

export const vRunStatus = v.union(
	v.literal('queued'),
	v.literal('running'),
	v.literal('awaiting_executor'),
	v.literal('completed'),
	v.literal('failed'),
	v.literal('cancelled')
);

export const runFinalStatus = ['cancelled', 'completed', 'failed'] as const;

export const vRunFinalStatus = v.union(...literals(runFinalStatus));

export function isRunFinalStatus(
	status: Infer<typeof vRunStatus>
): status is Infer<typeof vRunFinalStatus> {
	return (runFinalStatus as readonly string[]).includes(status);
}

export const vExecutorJobKind = v.union(
	v.literal('get_workspace_overview'),
	v.literal('get_workspace_instructions'),
	v.literal('read_file'),
	v.literal('create_file'),
	v.literal('replace_in_file')
);

export const vExecutorJobStatus = v.union(
	v.literal('pending'),
	v.literal('claimed'),
	v.literal('completed'),
	v.literal('failed'),
	v.literal('cancelled')
);

export const vThreadMessageRole = v.union(v.literal('user'), v.literal('assistant'));

export type ThreadMessageRole = Infer<typeof vThreadMessageRole>;

export const vThreadMessageStatus = v.union(
	v.literal('streaming'),
	v.literal('success'),
	v.literal('failed')
);

export type ThreadMessageStatus = Infer<typeof vThreadMessageStatus>;

export const vAssistantTextPart = v.object({
	type: v.literal('text'),
	id: v.string(),
	text: v.string()
});

export const vAssistantReasoningPart = v.object({
	type: v.literal('reasoning'),
	id: v.string(),
	text: v.string()
});

export const vAssistantToolCallPart = v.object({
	type: v.literal('tool-call'),
	callId: v.string(),
	name: v.string(),
	input: v.any()
});

export const vAssistantToolResultPart = v.object({
	type: v.literal('tool-result'),
	callId: v.string(),
	name: v.optional(v.string()),
	output: v.any()
});

export const vAssistantMessagePart = v.union(
	vAssistantTextPart,
	vAssistantReasoningPart,
	vAssistantToolCallPart,
	vAssistantToolResultPart
);

export const vAgentHistoryRole = v.union(
	v.literal('system'),
	v.literal('user'),
	v.literal('assistant')
);

export const vAgentHistoryToolResultItem = v.union(
	v.object({
		type: v.literal('text'),
		text: v.string()
	}),
	v.object({
		type: v.literal('image'),
		imageJson: v.string()
	})
);

export const vAgentHistoryContent = v.union(
	v.object({
		type: v.literal('text'),
		text: v.string()
	}),
	v.object({
		type: v.literal('reasoning'),
		id: v.optional(v.string()),
		blocksJson: v.string()
	}),
	v.object({
		type: v.literal('toolCall'),
		callId: v.string(),
		name: v.string(),
		argumentsJson: v.string(),
		signature: v.optional(v.string()),
		additionalParamsJson: v.optional(v.string())
	}),
	v.object({
		type: v.literal('toolResult'),
		callId: v.string(),
		items: v.array(vAgentHistoryToolResultItem)
	}),
	v.object({
		type: v.literal('image'),
		imageJson: v.string()
	}),
	v.object({
		type: v.literal('audio'),
		audioJson: v.string()
	}),
	v.object({
		type: v.literal('video'),
		videoJson: v.string()
	}),
	v.object({
		type: v.literal('document'),
		documentJson: v.string()
	})
);

export const vAgentHistoryMessage = v.object({
	role: vAgentHistoryRole,
	assistantId: v.optional(v.string()),
	contents: v.array(vAgentHistoryContent)
});

export type AgentHistoryMessage = Infer<typeof vAgentHistoryMessage>;

export const threadMessageFinalStatus = ['success', 'failed'] as const;

export const vThreadMessageFinalStatus = v.union(...literals(threadMessageFinalStatus));

export function isThreadMessageFinalStatus(
	status: Infer<typeof vThreadMessageStatus>
): status is Infer<typeof vThreadMessageFinalStatus> {
	return (threadMessageFinalStatus as readonly string[]).includes(status);
}

export const vWorkspaceToolRequest = v.object({
	jobId: v.optional(v.string()),
	workspaceRoot: v.string(),
	toolName: vExecutorJobKind,
	payload: vExecutorJobPayload
});

export type ReadFilePayload = Infer<typeof vReadFilePayload>;
export type CreateFilePayload = Infer<typeof vCreateFilePayload>;
export type ReplaceInFilePayload = Infer<typeof vReplaceInFilePayload>;
export type ExecutorJobPayload = Infer<typeof vExecutorJobPayload>;
export type FileReadResult = Infer<typeof vFileReadResult>;
export type FileWriteResult = Infer<typeof vFileWriteResult>;
export type FileEditResult = Infer<typeof vFileEditResult>;
export type ExecutorJobResult = Infer<typeof vExecutorJobResult>;
export type WorkspaceOverview = Infer<typeof vWorkspaceOverview>;
export type WorkspaceInstruction = Infer<typeof vWorkspaceInstruction>;
export type WorkspaceToolRequest = Infer<typeof vWorkspaceToolRequest>;
