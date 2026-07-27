import { v, type Infer } from 'convex/values';
import { modelIds, reasoningEffortIds, serviceTierIds } from '@convex/lib/models';
import { completionProviders, credentialProviders } from '@convex/lib/providers';
import { subscriptionTierIds } from '@convex/lib/tiers';

function literals<const TValues extends readonly string[]>(values: TValues) {
	return values.map((value) => v.literal(value)) as {
		[K in keyof TValues]: ReturnType<typeof v.literal<TValues[K]>>;
	};
}

export const vReasoningEffort = v.union(...literals(reasoningEffortIds));

export const vServiceTier = v.union(...literals(serviceTierIds));

export const vModelId = v.union(...literals(modelIds));

export const vSubscriptionTier = v.union(...literals(subscriptionTierIds));

export const vCompletionProviderId = v.union(...literals(completionProviders));
export type CompletionProviderId = Infer<typeof vCompletionProviderId>;

export const vCredentialProviderId = v.union(...literals(credentialProviders));
export type CredentialProviderId = Infer<typeof vCredentialProviderId>;

export const vSubscriptionStatus = v.union(
	v.literal('active'),
	v.literal('on_hold'),
	v.literal('cancelled'),
	v.literal('expired'),
	v.literal('failed')
);

export const vWorkspaceInstruction = v.object({
	path: v.string(),
	directory: v.string(),
	contents: v.string(),
	truncated: v.boolean()
});

export const vApplyPatchPayload = v.object({
	patch: v.string()
});

export const vExecCommandPayload = v.object({
	cmd: v.string(),
	workdir: v.optional(v.string()),
	shell: v.optional(v.string()),
	timeoutMs: v.optional(v.number()),
	yieldTimeMs: v.optional(v.number()),
	maxOutputChars: v.optional(v.number())
});

export const vScrapeUrlPayload = v.object({
	url: v.string()
});

export const vWebSearchPayload = v.object({
	query: v.string(),
	numResults: v.optional(v.number())
});

export const vWriteStdinPayload = v.object({
	sessionId: v.string(),
	chars: v.optional(v.string()),
	terminate: v.optional(v.boolean()),
	yieldTimeMs: v.optional(v.number())
});

export const vReadSkillPayload = v.object({
	name: v.string()
});

export const vExecutorJobPayload = v.union(
	v.object({}),
	vApplyPatchPayload,
	vExecCommandPayload,
	vReadSkillPayload,
	vScrapeUrlPayload,
	vWebSearchPayload,
	vWriteStdinPayload
);

export const vApplyPatchResult = v.object({
	changes: v.array(
		v.object({
			path: v.string(),
			operation: v.union(
				v.literal('created'),
				v.literal('updated'),
				v.literal('deleted'),
				v.literal('renamed'),
				v.literal('copied')
			)
		})
	)
});

export const vCommandExecResult = v.object({
	command: v.string(),
	cwd: v.string(),
	sessionId: v.optional(v.string()),
	exitCode: v.optional(v.number()),
	success: v.boolean(),
	running: v.boolean(),
	timedOut: v.boolean(),
	stdout: v.string(),
	stderr: v.string(),
	output: v.string(),
	truncated: v.boolean(),
	error: v.optional(v.string())
});

export const vScrapeUrlResult = v.object({
	url: v.string(),
	markdown: v.string(),
	truncated: v.boolean()
});

export const vWebSearchResult = v.object({
	results: v.array(
		v.object({
			title: v.optional(v.string()),
			url: v.string(),
			publishedDate: v.optional(v.string()),
			author: v.optional(v.string()),
			text: v.optional(v.string())
		})
	)
});

export const vReadSkillResult = v.object({
	name: v.string(),
	description: v.string(),
	content: v.string(),
	dir: v.optional(v.string()),
	truncated: v.optional(v.boolean())
});

export const vExecutorJobResult = v.union(
	v.string(),
	v.array(vWorkspaceInstruction),
	vApplyPatchResult,
	vCommandExecResult,
	vReadSkillResult,
	vScrapeUrlResult,
	vWebSearchResult
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
	v.literal('apply_patch'),
	v.literal('exec_command'),
	v.literal('get_workspace_instructions'),
	v.literal('read_skill'),
	v.literal('scrape_url'),
	v.literal('web_search'),
	v.literal('write_stdin')
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

export const supportedImageMediaTypes = [
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp'
] as const;

export const vImageMediaType = v.union(...literals(supportedImageMediaTypes));

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_LABEL = '10 MiB';

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
