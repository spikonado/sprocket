import { v, type Infer } from 'convex/values';
import { vJsonValue } from '@convex/lib/json';
import { reasoningEffortIds, serviceTierIds } from '@convex/lib/models';
import { subscriptionTierIds } from '@convex/lib/tiers';

function literals<const TValues extends readonly string[]>(values: TValues) {
	// SAFETY: map emits one v.literal per input string, matching TValues by index.
	return values.map((value) => v.literal(value)) as {
		[K in keyof TValues]: ReturnType<typeof v.literal<TValues[K]>>;
	};
}

export const vReasoningEffort = v.union(...literals(reasoningEffortIds));

export const vServiceTier = v.union(...literals(serviceTierIds));

export const vSubscriptionTier = v.union(...literals(subscriptionTierIds));

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

export const vArtifactType = v.union(v.literal('markdown'), v.literal('html'), v.literal('react'));

export const vCreateArtifactPayload = v.object({
	title: v.string(),
	contentType: vArtifactType,
	content: v.string()
});

export const vUpdateArtifactPayload = v.object({
	artifactId: v.string(),
	content: v.string()
});

export const vReadSkillPayload = v.object({
	name: v.string()
});

export const vBrowserActPayload = v.object({
	instruction: v.optional(v.string()),
	action: v.optional(
		v.object({
			selector: v.string(),
			description: v.string(),
			method: v.optional(v.string()),
			arguments: v.optional(v.array(v.string()))
		})
	),
	startUrl: v.optional(v.string())
});

const mandateFrequencies = ['one_time', 'weekly', 'monthly', 'yearly'] as const;
export const vMandateFrequency = v.union(...literals(mandateFrequencies));

export const vMandateScope = v.union(v.literal('listed'), v.literal('any'));

const mandateStatuses = [
	'pending',
	'active',
	'paused',
	'consumed',
	'cancelled',
	'expired'
] as const;
export const vMandateStatus = v.union(...literals(mandateStatuses));

export function isMandateStatus(
	status: string | undefined
): status is Infer<typeof vMandateStatus> {
	return status !== undefined && mandateStatuses.some((allowed) => allowed === status);
}

export const vMandateChargeStatus = v.union(
	v.literal('awaiting_result'),
	v.literal('completed'),
	v.literal('declined'),
	v.literal('failed')
);

export const vMandateReportOutcome = v.union(v.literal('approved'), v.literal('declined'));

export const vMandateSetupPayload = v.object({
	// Stored executorJobs payloads from older agents may still carry it.
	userEmail: v.optional(v.string()),
	merchantName: v.optional(v.string()),
	merchantUrl: v.optional(v.string()),
	countryCode: v.optional(v.string()),
	amountCap: v.string(),
	currency: v.string(),
	frequency: vMandateFrequency,
	scope: vMandateScope,
	description: v.string(),
	maxCharges: v.optional(v.number()),
	validUntil: v.optional(v.string())
});

export const vMandateIdPayload = v.object({
	mandateId: v.string()
});

export const vMandateChargePayload = v.object({
	mandateId: v.string(),
	amount: v.string(),
	currency: v.string(),
	description: v.string(),
	reference: v.optional(v.string())
});

export const vMandateReportPayload = v.object({
	chargeId: v.string(),
	outcome: vMandateReportOutcome,
	amountPaid: v.optional(v.string())
});

export const vAskQuestionOption = v.object({
	id: v.string(),
	label: v.string()
});

export const vAskQuestionPayload = v.object({
	question: v.string(),
	options: v.array(vAskQuestionOption),
	yieldTimeMs: v.optional(v.number()),
	timeoutMs: v.optional(v.number())
});

export const vAwaitQuestionPayload = v.object({
	questionId: v.id('agentQuestions'),
	yieldTimeMs: v.optional(v.number())
});

export const vExecutorJobPayload = v.union(
	v.object({}),
	vApplyPatchPayload,
	vAskQuestionPayload,
	vAwaitQuestionPayload,
	vExecCommandPayload,
	vReadSkillPayload,
	vScrapeUrlPayload,
	vWebSearchPayload,
	vWriteStdinPayload,
	vCreateArtifactPayload,
	vUpdateArtifactPayload,
	vBrowserActPayload,
	vMandateSetupPayload,
	vMandateIdPayload,
	vMandateChargePayload,
	vMandateReportPayload
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

const vLegacyCommandExecResult = v.object({
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

export const vCommandExecResult = v.object({
	command: v.string(),
	cwd: v.string(),
	output: v.string(),
	sessionId: v.optional(v.string()),
	exitCode: v.optional(v.number()),
	success: v.boolean(),
	running: v.boolean(),
	timedOut: v.boolean(),
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

export const vMandateSetupResult = v.object({
	mandateId: v.id('mandates'),
	approvalUrl: v.string(),
	expiresAt: v.string()
});

export const vMandateStatusResult = v.object({
	mandateId: v.id('mandates'),
	pravaMandateId: v.optional(v.string()),
	status: vMandateStatus,
	// Optional for older persisted executor job results that predate the field.
	description: v.optional(v.string()),
	merchantName: v.optional(v.string()),
	/** Decimal string for agent/Prava wire format (e.g. "120.00"). */
	amountCap: v.string(),
	remaining: v.optional(v.string()),
	currency: v.string(),
	frequency: vMandateFrequency,
	scope: vMandateScope,
	approvalUrl: v.optional(v.string()),
	validUntil: v.optional(v.string()),
	renewsAt: v.optional(v.string())
});

export const vMandateListResult = v.object({
	mandates: v.array(
		v.object({
			mandateId: v.optional(v.id('mandates')),
			pravaMandateId: v.string(),
			status: v.string(),
			description: v.optional(v.string()),
			merchantName: v.optional(v.string()),
			approvedAmount: v.string(),
			remaining: v.optional(v.string()),
			currency: v.string(),
			validUntil: v.optional(v.string()),
			renewsAt: v.optional(v.string())
		})
	)
});

export const vMandateChargeResult = v.object({
	chargeId: v.id('mandateCharges'),
	transactionId: v.string(),
	/** Present only on a freshly issued charge, never persisted or replayed. */
	token: v.optional(v.string()),
	dynamicCvv: v.optional(v.string()),
	expiryMonth: v.optional(v.string()),
	expiryYear: v.optional(v.string())
});

export const vMandateReportResult = v.object({
	reported: v.boolean(),
	alreadyReported: v.optional(v.boolean()),
	inFlight: v.optional(v.boolean())
});

export const vBrowserTaskResult = v.object({
	text: v.string(),
	truncated: v.boolean()
});

export const vBrowserObservedAction = v.object({
	selector: v.string(),
	description: v.string(),
	method: v.optional(v.string()),
	arguments: v.optional(v.array(v.string()))
});

export const vBrowserObserveResult = v.object({
	actions: v.array(vBrowserObservedAction),
	text: v.string(),
	truncated: v.boolean()
});

export const vReadSkillResult = v.object({
	name: v.string(),
	description: v.string(),
	content: v.string(),
	dir: v.optional(v.string()),
	truncated: v.optional(v.boolean())
});

export const vAskQuestionAnswer = v.object({
	optionId: v.optional(v.string()),
	optionLabel: v.optional(v.string()),
	text: v.optional(v.string())
});

export const vAskQuestionResult = v.object({
	questionId: v.id('agentQuestions'),
	question: v.string(),
	options: v.array(vAskQuestionOption),
	pending: v.boolean(),
	timedOut: v.boolean(),
	answer: v.optional(vAskQuestionAnswer)
});

export const vArtifactResult = v.object({
	artifactId: v.string(),
	version: v.number(),
	title: v.optional(v.string()),
	contentType: v.optional(vArtifactType)
});

export const vExecutorJobResult = v.union(
	v.string(),
	v.array(vWorkspaceInstruction),
	vApplyPatchResult,
	vAskQuestionResult,
	v.union(vCommandExecResult, vLegacyCommandExecResult),
	vReadSkillResult,
	vScrapeUrlResult,
	vWebSearchResult,
	vArtifactResult,
	vBrowserTaskResult,
	vBrowserObserveResult,
	vMandateSetupResult,
	vMandateStatusResult,
	vMandateListResult,
	vMandateChargeResult,
	vMandateReportResult
);

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
	return runFinalStatus.some((allowed) => allowed === status);
}

export const vExecutorJobKind = v.union(
	v.literal('apply_patch'),
	v.literal('ask_question'),
	v.literal('await_question'),
	v.literal('browser_observe'),
	v.literal('browser_act'),
	v.literal('browser_extract'),
	v.literal('exec_command'),
	v.literal('get_workspace_instructions'),
	v.literal('mandate_setup'),
	v.literal('mandate_status'),
	v.literal('mandate_list'),
	v.literal('mandate_charge'),
	v.literal('mandate_report'),
	v.literal('read_skill'),
	v.literal('scrape_url'),
	v.literal('web_search'),
	v.literal('write_stdin'),
	v.literal('create_artifact'),
	v.literal('update_artifact')
);

export const vAgentQuestionStatus = v.union(
	v.literal('pending'),
	v.literal('answered'),
	v.literal('timedOut'),
	v.literal('cancelled')
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

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_LABEL = '10 MiB';

export const vAssistantTextPart = v.object({
	type: v.literal('text'),
	id: v.string(),
	text: v.string(),
	turnId: v.optional(v.string()),
	providerMetadata: v.optional(vJsonValue)
});

export const vAssistantReasoningPart = v.object({
	type: v.literal('reasoning'),
	id: v.string(),
	text: v.string(),
	turnId: v.optional(v.string()),
	providerMetadata: v.optional(vJsonValue)
});

export const vAssistantToolCallPart = v.object({
	type: v.literal('tool-call'),
	partId: v.optional(v.string()),
	callId: v.string(),
	name: v.string(),
	input: vJsonValue,
	turnId: v.optional(v.string()),
	providerMetadata: v.optional(vJsonValue)
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
	output: vJsonValue
});

export const vAssistantMessagePart = v.union(
	vAssistantTextPart,
	vAssistantReasoningPart,
	vAssistantToolCallPart,
	vAssistantToolResultPart
);

export type AssistantTextPart = Infer<typeof vAssistantTextPart>;
export type AssistantReasoningPart = Infer<typeof vAssistantReasoningPart>;
export type AssistantToolCallPart = Infer<typeof vAssistantToolCallPart>;
export type AssistantToolResultPart = Infer<typeof vAssistantToolResultPart>;
export type AssistantMessagePart = Infer<typeof vAssistantMessagePart>;

export const vTranscriptPartKind = v.union(
	v.literal('prompt'),
	v.literal('completion'),
	v.literal('tool')
);

export const vTranscriptAttachmentMeta = v.object({
	imageUploadId: v.id('imageUploads'),
	name: v.string(),
	mediaType: v.string(),
	size: v.number(),
	storageId: v.id('_storage'),
	url: v.optional(v.string())
});

export const vTranscriptCompletionItem = v.union(
	vAssistantTextPart,
	vAssistantReasoningPart,
	vAssistantToolCallPart
);

export const vTranscriptPromptBody = v.object({
	text: v.string(),
	imageUploads: v.array(vTranscriptAttachmentMeta)
});

export const vTranscriptCompletionBody = v.object({
	streamId: v.optional(v.string()),
	items: v.array(vTranscriptCompletionItem)
});

export const vTranscriptToolStatus = v.union(
	v.literal('completed'),
	v.literal('failed'),
	v.literal('cancelled')
);

export const vTranscriptToolBody = v.object({
	jobId: v.optional(v.id('executorJobs')),
	callId: v.string(),
	name: v.string(),
	output: vJsonValue,
	status: vTranscriptToolStatus
});

export type TranscriptCompletionItem = Infer<typeof vTranscriptCompletionItem>;
export type TranscriptPromptBody = Infer<typeof vTranscriptPromptBody>;
export type TranscriptCompletionBody = Infer<typeof vTranscriptCompletionBody>;
export type TranscriptToolBody = Infer<typeof vTranscriptToolBody>;

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
export type ArtifactType = Infer<typeof vArtifactType>;
