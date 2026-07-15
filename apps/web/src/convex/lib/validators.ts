import { v, type Infer } from 'convex/values';
import { modelIds, reasoningEffortIds } from '@convex/lib/models';

function literals<const TValues extends readonly string[]>(values: TValues) {
	return values.map((value) => v.literal(value)) as {
		[K in keyof TValues]: ReturnType<typeof v.literal<TValues[K]>>;
	};
}

export const vReasoningEffort = v.union(...literals(reasoningEffortIds));

export const vModelId = v.union(...literals(modelIds));

export const vWorkspaceInstruction = v.object({
	path: v.string(),
	directory: v.string(),
	contents: v.string(),
	truncated: v.boolean()
});

export const vExecCommandPayload = v.object({
	cmd: v.string(),
	workdir: v.optional(v.string()),
	shell: v.optional(v.string()),
	login: v.optional(v.boolean()),
	timeoutMs: v.optional(v.number()),
	maxOutputChars: v.optional(v.number())
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
	vExecCommandPayload,
	vCreateFilePayload,
	vReplaceInFilePayload
);

export const vCommandExecResult = v.object({
	command: v.string(),
	cwd: v.optional(v.string()),
	exitCode: v.optional(v.number()),
	success: v.boolean(),
	timedOut: v.boolean(),
	stdout: v.string(),
	stderr: v.string(),
	output: v.string(),
	truncated: v.boolean()
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
	v.string(),
	v.array(vWorkspaceInstruction),
	vCommandExecResult,
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
	v.literal('exec_command'),
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

export const vThreadMessageType = v.union(v.literal('prompt'), v.literal('response'));

export type ThreadMessageType = Infer<typeof vThreadMessageType>;

export const vAssistantTextPart = v.object({
	type: v.literal('text'),
	id: v.string(),
	text: v.string(),
	turnId: v.optional(v.string()),
	providerMetadata: v.optional(v.any())
});

export const vAssistantReasoningPart = v.object({
	type: v.literal('reasoning'),
	id: v.string(),
	text: v.string(),
	turnId: v.optional(v.string()),
	providerMetadata: v.optional(v.any())
});

export const vAssistantToolCallPart = v.object({
	type: v.literal('tool-call'),
	partId: v.optional(v.string()),
	callId: v.string(),
	name: v.string(),
	input: v.any(),
	turnId: v.optional(v.string()),
	providerMetadata: v.optional(v.any())
});

export const assistantToolResultErrorStatuses = ['cancelled', 'failed'] as const;

export const vAssistantToolResultErrorStatus = v.union(
	...literals(assistantToolResultErrorStatuses)
);

/** Persisted tool-result error output. */
export const vAssistantToolResultErrorOutput = v.object({
	error: v.string(),
	status: vAssistantToolResultErrorStatus
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
		text: v.string(),
		additionalParamsJson: v.optional(v.string())
	}),
	v.object({
		type: v.literal('reasoning'),
		id: v.optional(v.string()),
		blocksJson: v.string()
	}),
	v.object({
		type: v.literal('toolCall'),
		id: v.string(),
		callId: v.optional(v.string()),
		name: v.string(),
		argumentsJson: v.string(),
		signature: v.optional(v.string()),
		additionalParamsJson: v.optional(v.string())
	}),
	v.object({
		type: v.literal('toolResult'),
		id: v.string(),
		callId: v.optional(v.string()),
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

export type ExecutorJobPayload = Infer<typeof vExecutorJobPayload>;
export type ExecutorJobResult = Infer<typeof vExecutorJobResult>;
export type AssistantToolResultErrorStatus = Infer<typeof vAssistantToolResultErrorStatus>;
export type AssistantToolResultErrorOutput = Infer<typeof vAssistantToolResultErrorOutput>;
export type WorkspaceInstruction = Infer<typeof vWorkspaceInstruction>;
