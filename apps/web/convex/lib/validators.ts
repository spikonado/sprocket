import { v, type Infer } from 'convex/values';
import { vJsonValue } from '@convex/lib/json';
import { reasoningEffortIds } from '@convex/lib/models';

function literals<const TValues extends readonly string[]>(values: TValues) {
	// SAFETY: map emits one v.literal per input string, matching TValues by index.
	return values.map((value) => v.literal(value)) as {
		[K in keyof TValues]: ReturnType<typeof v.literal<TValues[K]>>;
	};
}

export const vReasoningEffort = v.union(...literals(reasoningEffortIds));

export const completionProviderIds = ['spikonado', 'openai', 'chatgpt'] as const;

export type CompletionProvider = (typeof completionProviderIds)[number];

export const vCompletionProvider = v.union(...literals(completionProviderIds));

export const vServiceTier = v.union(v.literal('standard'), v.literal('fast'));

/** Provider-reported tokens. Cache counts are part of `inputTokens`; reasoning is part of `outputTokens`. */
export const vTokenCounts = v.object({
	inputTokens: v.number(),
	cacheReadTokens: v.number(),
	cacheWriteTokens: v.number(),
	outputTokens: v.number(),
	reasoningTokens: v.number()
});

export type TokenCounts = Infer<typeof vTokenCounts>;

/** The fields that pick a call's totals row. `cacheWriteTtl` is null when the catalog didn't say; it keys the write price. */
const usageKeyFields = {
	provider: vCompletionProvider,
	model: v.string(),
	serviceTier: vServiceTier,
	cacheWriteTtl: v.union(v.string(), v.null())
};

/**
 * One completion call as the agent saw it. `longContext` means the call crossed the model's direct-API long-context price threshold.
 */
export const vModelCallUsage = v.object({
	...usageKeyFields,
	longContext: v.boolean(),
	...vTokenCounts.fields
});

export type ModelCallUsage = Infer<typeof vModelCallUsage>;

/** Totals for one usage key, with long-context calls kept apart for pricing. */
export const vTokenUsageTotals = v.object({
	...usageKeyFields,
	calls: v.number(),
	standard: vTokenCounts,
	longContext: vTokenCounts
});

export type TokenUsageTotals = Infer<typeof vTokenUsageTotals>;

/** Tier ids are gateway-owned and dynamic, so this stays an open string. */
export const vSubscriptionTier = v.string();

export const vBillingInterval = v.union(v.literal('monthly'), v.literal('annual'));

// Public checkout mode surfaced to the website; never exposes raw provider
// environment naming.
export const vDodoMode = v.union(v.literal('test'), v.literal('live'));

export const vSubscriptionStatus = v.union(
	v.literal('active'),
	v.literal('on_hold'),
	v.literal('cancelled'),
	v.literal('expired'),
	v.literal('failed')
);

// Neutral provider-backed attempt status; never asserts entitlement by itself.
export const vCheckoutAttemptStatus = v.union(
	v.literal('awaiting_payment'),
	v.literal('pending'),
	v.literal('succeeded'),
	v.literal('failed'),
	v.literal('expired'),
	v.literal('unknown')
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
	// Historical jobs only; exec_cmd now runs in the thread's cwd.
	workdir: v.optional(v.string()),
	shell: v.optional(v.string()),
	timeoutMs: v.optional(v.number()),
	yieldTimeMs: v.optional(v.number()),
	maxOutputChars: v.optional(v.number())
});

export const vScrapeUrlPayload = v.object({
	url: v.string(),
	query: v.optional(v.string())
});

/** screenshot_url job payload. */
export const vScreenshotUrlPayload = vScrapeUrlPayload.pick('url');

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

export const vControlCommandPayload = v.object({
	sessionId: v.string(),
	action: v.union(v.literal('write'), v.literal('terminate')),
	chars: v.optional(v.string()),
	yieldTimeMs: v.optional(v.number())
});

export const vPollCommandPayload = vWriteStdinPayload.pick('sessionId', 'yieldTimeMs');

export const vArtifactType = v.union(v.literal('markdown'), v.literal('html'), v.literal('react'));

// Historical stored artifacts and tool results retain thread scope until migrated.
export const vArtifactScope = v.union(v.literal('thread'), v.literal('project'));

export const vAddArtifactPayload = v.object({
	scope: v.optional(vArtifactScope)
});

export const vEditArtifactPayload = v.object({
	artifactId: v.string()
});

// Stored leftover executorJobs from create_artifact / update_artifact.
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

export const vSetCwdPayload = v.object({
	path: v.string()
});

export const vLinkPrsPayload = v.object({
	pullRequests: v.array(v.object({ repository: v.string(), number: v.number() }))
});

export const vPullRequestState = v.union(
	v.literal('open'),
	v.literal('closed'),
	v.literal('merged')
);

export const vLinkedPullRequest = v.object({
	repository: v.string(),
	number: v.number(),
	state: vPullRequestState,
	title: v.string()
});

export type LinkedPullRequest = Infer<typeof vLinkedPullRequest>;

const vHistoricalBrowserActPayload = v.object({
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

// Stored executorJobs payloads from the retired Firecrawl browser tools.
const vBrowserInteractPayload = v.object({
	command: v.string(),
	enforce_saving: v.optional(v.boolean())
});

// Retired Prava mandate tools. Released agents still send these kinds, which
// beginToolJob rejects, and stored jobs keep them as history.
const vMandateFrequency = v.union(
	...literals(['one_time', 'weekly', 'monthly', 'yearly'] as const)
);

const vMandateScope = v.union(v.literal('listed'), v.literal('any'));

const vMandateReportOutcome = v.union(v.literal('approved'), v.literal('declined'));

const vMandateSetupPayload = v.object({
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

const vMandateIdPayload = v.object({
	mandateId: v.string()
});

const vMandateChargePayload = v.object({
	mandateId: v.string(),
	amount: v.string(),
	currency: v.string(),
	description: v.string(),
	reference: v.optional(v.string())
});

const vMandateReportPayload = v.object({
	chargeId: v.string(),
	outcome: vMandateReportOutcome,
	amountPaid: v.optional(v.string())
});

export const retiredMandateToolKinds: ReadonlySet<string> = new Set([
	'mandate_setup',
	'mandate_status',
	'mandate_list',
	'mandate_charge',
	'mandate_report'
]);

export const vCardCheckoutPayload = v.object({
	amount: v.string(),
	currency: v.string(),
	payButton: v.string()
});

export const vReportOrderPayload = v.object({
	purchaseId: v.string(),
	orderNumber: v.string()
});

export const purchaseStatuses = [
	'awaiting_approval',
	'approved',
	'submitted_on_device',
	'declined',
	'expired',
	'settled'
] as const;

export type PurchaseStatus = (typeof purchaseStatuses)[number];

export const vPurchaseStatus = v.union(...literals(purchaseStatuses));

export const vAskQuestionOption = v.object({
	id: v.string(),
	label: v.string()
});

export const vAskQuestionPayload = v.object({
	question: v.string(),
	options: v.array(vAskQuestionOption),
	yieldTimeMs: v.optional(v.number()),
	timeoutMs: v.optional(v.union(v.number(), v.null()))
});

export const vAwaitQuestionPayload = v.object({
	questionId: v.id('agentQuestions'),
	yieldTimeMs: v.optional(v.number())
});

export const vParseFilePayload = v.union(
	v.object({ path: v.string() }),
	v.object({ url: v.string() })
);

export const vSubagentPayload = v.object({
	threadId: v.optional(v.id('threadRecords')),
	prompt: v.string(),
	model: v.optional(v.string()),
	reasoning: v.optional(v.string()),
	fast: v.optional(v.boolean()),
	yieldTimeMs: v.optional(v.number()),
	timeoutMs: v.optional(v.number())
});

export const vControlSubagentPayload = vSubagentPayload.partial().extend({
	threadId: v.id('threadRecords'),
	action: v.union(v.literal('send'), v.literal('stop'), v.literal('answer_question')),
	questionId: v.optional(v.id('agentQuestions')),
	optionId: v.optional(v.string()),
	text: v.optional(v.string())
});

export const vPollSubagentPayload = v.object({
	threadId: v.id('threadRecords'),
	cursor: v.optional(v.string()),
	yieldTimeMs: v.optional(v.number())
});

export const vListSubagentsPayload = v.object({
	parentThreadId: v.optional(v.id('threadRecords')),
	cursor: v.optional(v.string())
});

export const vCurrentExecutorJobPayload = v.union(
	v.object({}),
	vParseFilePayload,
	vSubagentPayload,
	vControlSubagentPayload,
	vPollSubagentPayload,
	vListSubagentsPayload,
	vApplyPatchPayload,
	vAskQuestionPayload,
	vAwaitQuestionPayload,
	vExecCommandPayload,
	vReadSkillPayload,
	vSetCwdPayload,
	vLinkPrsPayload,
	vScrapeUrlPayload,
	vScreenshotUrlPayload,
	vWebSearchPayload,
	vWriteStdinPayload,
	vControlCommandPayload,
	vPollCommandPayload,
	vAddArtifactPayload,
	vEditArtifactPayload,
	vCreateArtifactPayload,
	vUpdateArtifactPayload,
	vMandateSetupPayload,
	vMandateIdPayload,
	vMandateChargePayload,
	vMandateReportPayload,
	vCardCheckoutPayload,
	vReportOrderPayload
);

export const vExecutorJobPayload = v.union(
	vCurrentExecutorJobPayload,
	vHistoricalBrowserActPayload,
	vBrowserInteractPayload
);

export const vApplyPatchResult = v.object({
	changes: v.array(
		v.object({
			path: v.string(),
			source: v.optional(v.string()),
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

const vLegacyCommandResult = v.object({
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

const vCommandOutput = v.object({
	output: v.optional(v.string()),
	exitCode: v.optional(v.number()),
	success: v.optional(v.boolean()),
	running: v.boolean(),
	timedOut: v.optional(v.boolean()),
	completeLogPath: v.string(),
	eventsPath: v.optional(v.string()),
	error: v.optional(v.string())
});

export const vCommandExecResult = vCommandOutput.extend({
	sessionId: v.optional(v.string())
});

export const vCommandStdinResult = vCommandOutput.extend({
	command: v.string(),
	workdir: v.string()
});

export const vPageOutline = v.object({
	title: v.optional(v.string()),
	description: v.optional(v.string()),
	headings: v.array(v.object({ level: v.number(), text: v.string() }))
});

/** Stored scrape_url job result. Historical rows may include `summary`. */
export const vScrapeUrlResult = v.object({
	url: v.string(),
	markdown: v.string(),
	summary: v.optional(v.string()),
	outline: v.optional(vPageOutline),
	highlights: v.optional(v.array(v.string())),
	// Agents omit it when they download an oversized scrape.
	images: v.optional(v.array(v.string()))
});

/** webRequests scrape transport. Oversized pages return a temporary JSON download URL. */
export const vScrapeUrlTransport = v.union(
	v.object({
		url: v.string(),
		markdown: v.string(),
		outline: vPageOutline,
		highlights: v.optional(v.array(v.string())),
		images: v.array(v.string())
	}),
	v.object({
		url: v.string(),
		outline: vPageOutline,
		highlights: v.optional(v.array(v.string())),
		scrapeUrl: v.string()
	})
);

export const vWebImageResult = v.object({
	outputType: v.literal('image'),
	url: v.string(),
	path: v.string(),
	mediaType: v.string(),
	byteSize: v.number(),
	width: v.number(),
	height: v.number()
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

// Stored results of the retired Prava mandate tools.
const vMandateSetupResult = v.object({
	mandateId: v.string(),
	approvalUrl: v.string(),
	expiresAt: v.string()
});

const vMandateStatusResult = v.object({
	mandateId: v.string(),
	pravaMandateId: v.optional(v.string()),
	status: v.string(),
	description: v.optional(v.string()),
	merchantName: v.optional(v.string()),
	amountCap: v.string(),
	remaining: v.optional(v.string()),
	currency: v.string(),
	frequency: v.string(),
	scope: v.string(),
	approvalUrl: v.optional(v.string()),
	validUntil: v.optional(v.string()),
	renewsAt: v.optional(v.string())
});

const vMandateListResult = v.object({
	mandates: v.array(
		v.object({
			mandateId: v.optional(v.string()),
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

const vMandateChargeResult = v.object({
	chargeId: v.string(),
	transactionId: v.string(),
	token: v.optional(v.string()),
	dynamicCvv: v.optional(v.string()),
	expiryMonth: v.optional(v.string()),
	expiryYear: v.optional(v.string())
});

const vMandateReportResult = v.object({
	reported: v.boolean(),
	alreadyReported: v.optional(v.boolean()),
	inFlight: v.optional(v.boolean())
});

export const vCardCheckoutResult = v.object({
	status: v.union(
		v.literal('approved'),
		v.literal('submitted_on_device'),
		v.literal('declined'),
		v.literal('expired'),
		v.literal('card_required'),
		v.literal('no_payment_request'),
		v.literal('outcome_unknown')
	),
	purchaseId: v.optional(v.string()),
	merchant: v.optional(v.string()),
	reason: v.optional(v.string())
});

export const vReportOrderResult = v.object({
	purchaseId: v.string()
});

export const vBrowserTaskResult = v.object({
	text: v.string(),
	truncated: v.boolean()
});

export const vBrowserScreenshotResult = v.object({
	mediaType: v.literal('image/png'),
	dataBase64: v.string(),
	byteLength: v.number(),
	truncated: v.boolean(),
	url: v.optional(v.string())
});

const vCachedBrowserScreenshotResult = vWebImageResult.omit('url').extend({
	mediaType: v.literal('image/png')
});

const vHistoricalBrowserObservedAction = v.object({
	selector: v.string(),
	description: v.string(),
	method: v.optional(v.string()),
	arguments: v.optional(v.array(v.string()))
});

const vHistoricalBrowserObserveResult = v.object({
	actions: v.array(vHistoricalBrowserObservedAction),
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

export const vSetCwdResult = v.object({
	cwd: v.string()
});

export const vAskQuestionAnswer = v.object({
	optionId: v.optional(v.string()),
	optionLabel: v.optional(v.string()),
	text: v.optional(v.string())
});

export const vPollQuestionResult = v.object({
	pending: v.boolean(),
	timedOut: v.boolean(),
	answer: v.optional(vAskQuestionAnswer)
});

export const vAskQuestionResult = vPollQuestionResult.extend({
	questionId: v.id('agentQuestions'),
	question: v.optional(v.string()),
	options: v.optional(v.array(vAskQuestionOption))
});

export const vRunStatus = v.union(
	v.literal('queued'),
	v.literal('running'),
	v.literal('completed'),
	v.literal('failed'),
	v.literal('cancelled')
);

export const vDescendantStatusCounts = v.object({
	queued: v.number(),
	running: v.number(),
	completed: v.number(),
	failed: v.number(),
	cancelled: v.number()
});

export const vSubagentSettings = v.object({
	model: v.string(),
	reasoning: vReasoningEffort,
	fast: v.boolean(),
	completionProvider: vCompletionProvider
});

const vSubagentPendingQuestion = v.object({
	questionId: v.id('agentQuestions'),
	question: v.string(),
	options: v.array(vAskQuestionOption)
});

const vSubagentMonitorEntry = v.union(
	v.object({ type: v.literal('prompt'), id: v.string(), text: v.string() }),
	v.object({ type: v.literal('text'), id: v.string(), text: v.string() }),
	v.object({
		type: v.literal('patch'),
		id: v.string(),
		ok: v.boolean(),
		changes: v.array(
			v.object({ operation: v.string(), path: v.string(), sourcePath: v.optional(v.string()) })
		)
	})
);

export const vSubagentActionResult = v.object({
	status: vRunStatus,
	lastError: v.optional(v.union(v.string(), v.null())),
	pendingQuestions: v.array(vSubagentPendingQuestion)
});

export const vSubagentSnapshotResult = vSubagentActionResult.extend({
	entries: v.array(vSubagentMonitorEntry),
	nextCursor: v.string(),
	hasMore: v.boolean()
});

const vSpawnSubagentFields = {
	threadId: v.id('threadRecords'),
	settings: vSubagentSettings
};

export const vSpawnSubagentResult = v.union(
	vSubagentActionResult.extend(vSpawnSubagentFields),
	vSubagentSnapshotResult.extend(vSpawnSubagentFields)
);

const vControlSubagentFields = {
	answer: v.optional(vAskQuestionAnswer),
	alreadyAnswered: v.optional(v.literal(true))
};

export const vControlSubagentResult = v.union(
	vSpawnSubagentResult,
	vSubagentActionResult.extend(vControlSubagentFields),
	vSubagentSnapshotResult.extend(vControlSubagentFields)
);

export const vListSubagentsResult = v.object({
	children: v.array(
		v.object({
			threadId: v.id('threadRecords'),
			parentThreadId: v.id('threadRecords'),
			title: v.optional(v.union(v.string(), v.null())),
			status: vRunStatus,
			lastError: v.optional(v.union(v.string(), v.null())),
			settings: vSubagentSettings
		})
	),
	nextCursor: v.union(v.string(), v.null()),
	hasMore: v.boolean()
});

export const vListModelsResult = v.object({
	defaultModelId: v.string(),
	defaultFast: v.boolean(),
	models: v.array(
		v.object({
			id: v.string(),
			label: v.string(),
			reasoningEfforts: v.array(v.string()),
			defaultReasoningEffort: v.string(),
			serviceTiers: v.array(v.string()),
			supportsImages: v.boolean()
		})
	)
});

export const vArtifactResult = v.object({
	artifactId: v.string(),
	revision: v.optional(v.number()),
	scope: v.optional(vArtifactScope),
	title: v.optional(v.string()),
	contentType: v.optional(vArtifactType),
	// Stored leftover create_artifact / update_artifact job results.
	version: v.optional(v.number())
});

export const vListArtifactsResult = v.object({
	artifacts: v.array(
		v.object({
			artifactId: v.string(),
			// Released tools include scope/thread metadata; current results omit it.
			scope: v.optional(vArtifactScope),
			repositoryKey: v.string(),
			threadId: v.optional(v.id('threadRecords')),
			type: vArtifactType,
			title: v.string(),
			revision: v.number(),
			// Released list tools and stored results include it; current results omit it.
			createdAt: v.optional(v.number()),
			updatedAt: v.number()
		})
	)
});

const vListConnectorsResult = v.object({
	connectors: v.array(v.object({ name: v.string(), version: v.string() }))
});

const vParsedFileSource = v.union(
	v.object({ type: v.literal('path'), path: v.string() }),
	v.object({ type: v.literal('url'), url: v.string() })
);

export const vParsedFileResult = v.union(
	v.object({
		outputType: v.literal('image'),
		mediaType: v.string(),
		path: v.string(),
		source: vParsedFileSource,
		byteSize: v.number(),
		width: v.number(),
		height: v.number()
	}),
	v.object({
		outputType: v.literal('text'),
		path: v.string(),
		source: vParsedFileSource,
		format: v.string(),
		charCount: v.number(),
		preview: v.string(),
		truncated: v.boolean()
	})
);

export const vExecutorJobResult = v.union(
	v.string(),
	vParsedFileResult,
	v.array(vWorkspaceInstruction),
	vApplyPatchResult,
	vAskQuestionResult,
	vPollQuestionResult,
	vSpawnSubagentResult,
	vControlSubagentResult,
	vSubagentSnapshotResult,
	vListSubagentsResult,
	vListModelsResult,
	vCommandExecResult,
	vCommandStdinResult,
	vLegacyCommandResult,
	vReadSkillResult,
	vSetCwdResult,
	vScrapeUrlResult,
	vWebImageResult,
	vWebSearchResult,
	vArtifactResult,
	vListArtifactsResult,
	vListConnectorsResult,
	vBrowserTaskResult,
	vBrowserScreenshotResult,
	vCachedBrowserScreenshotResult,
	vHistoricalBrowserObserveResult,
	vMandateSetupResult,
	vMandateStatusResult,
	vMandateListResult,
	vMandateChargeResult,
	vMandateReportResult,
	vCardCheckoutResult,
	vReportOrderResult
);

export const runFinalStatus = ['cancelled', 'completed', 'failed'] as const;

export const vRunFinalStatus = v.union(...literals(runFinalStatus));

export function isRunFinalStatus(
	status: Infer<typeof vRunStatus>
): status is Infer<typeof vRunFinalStatus> {
	return runFinalStatus.some((allowed) => allowed === status);
}

export const vCurrentExecutorJobKind = v.union(
	v.literal('apply_patch'),
	v.literal('ask_question'),
	v.literal('poll_question'),
	v.literal('exec_cmd'),
	v.literal('get_workspace_instructions'),
	v.literal('mandate_setup'),
	v.literal('mandate_status'),
	v.literal('mandate_list'),
	v.literal('mandate_charge'),
	v.literal('mandate_report'),
	v.literal('card_checkout'),
	v.literal('report_order'),
	v.literal('read_skill'),
	v.literal('set_cwd'),
	v.literal('link_prs'),
	v.literal('parse_file'),
	v.literal('scrape_url'),
	v.literal('screenshot_url'),
	v.literal('web_search'),
	v.literal('control_cmd'),
	v.literal('poll_cmd'),
	v.literal('add_artifact'),
	v.literal('list_artifacts'),
	v.literal('list_connectors'),
	v.literal('list_subagent_models'),
	v.literal('list_subagents'),
	v.literal('edit_artifact'),
	v.literal('delete_artifact'),
	v.literal('save_artifact'),
	v.literal('spawn_subagent'),
	v.literal('control_subagent'),
	v.literal('poll_subagent')
);

export const vExecutorJobKind = v.union(
	vCurrentExecutorJobKind,
	v.literal('await_question'),
	v.literal('exec_command'),
	v.literal('write_stdin'),
	v.literal('control_command'),
	v.literal('poll_command'),
	v.literal('browser_interact'),
	v.literal('browser_screenshot'),
	v.literal('browser_observe'),
	v.literal('browser_act'),
	v.literal('browser_extract')
);

export const vStoredExecutorJobKind = v.union(
	vExecutorJobKind,
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

export const MAX_FILE_NAME_LENGTH = 255;

export function registeredFileUploadError(name: string): string | null {
	const trimmed = name.trim();

	if (!trimmed || trimmed.length > MAX_FILE_NAME_LENGTH) {
		return 'Filename must be between 1 and 255 characters.';
	}

	return null;
}

const vAssistantTimestamp = v.optional(v.union(v.number(), v.null()));

export const vAssistantTextPart = v.object({
	type: v.literal('text'),
	id: v.string(),
	text: v.string(),
	startedAt: vAssistantTimestamp,
	completedAt: vAssistantTimestamp,
	turnId: v.optional(v.string()),
	providerMetadata: v.optional(vJsonValue)
});

export const vAssistantReasoningPart = v.object({
	type: v.literal('reasoning'),
	id: v.string(),
	text: v.string(),
	startedAt: vAssistantTimestamp,
	completedAt: vAssistantTimestamp,
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
	startedAt: vAssistantTimestamp,
	completedAt: vAssistantTimestamp,
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
	completedAt: vAssistantTimestamp,
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

/** Prompts the agent writes for the model; the UI does not show them. */
export const vHiddenPromptKind = v.union(
	v.literal('instructions'),
	v.literal('environment'),
	v.literal('continuation')
);

export const vHiddenPrompt = v.object({ kind: vHiddenPromptKind, text: v.string() });

export type HiddenPrompt = Infer<typeof vHiddenPrompt>;

export const vTranscriptPromptBody = v.object({
	text: v.string(),
	imageUploads: v.array(vTranscriptAttachmentMeta),
	hidden: v.optional(vHiddenPromptKind)
});

export const vTranscriptCompletionBody = v.object({
	streamId: v.optional(v.string()),
	items: v.array(vTranscriptCompletionItem)
});

export const vTranscriptToolStatus = v.union(
	v.literal('started'),
	v.literal('completed'),
	v.literal('failed'),
	v.literal('cancelled')
);

export const vTranscriptToolBody = v.object({
	toolInvocationId: v.string(),
	callId: v.string(),
	name: v.string(),
	input: v.optional(vJsonValue),
	output: v.optional(vJsonValue),
	status: vTranscriptToolStatus
});

export type TranscriptCompletionItem = Infer<typeof vTranscriptCompletionItem>;

export type TranscriptPromptBody = Infer<typeof vTranscriptPromptBody>;

export type TranscriptCompletionBody = Infer<typeof vTranscriptCompletionBody>;

export type TranscriptToolBody = Infer<typeof vTranscriptToolBody>;

export type ExecutorJobPayload = Infer<typeof vExecutorJobPayload>;

export type ExecutorJobResult = Infer<typeof vExecutorJobResult>;

export type AssistantToolResultErrorStatus = Infer<typeof vAssistantToolResultErrorStatus>;

export type AssistantToolResultErrorOutput = Infer<typeof vAssistantToolResultErrorOutput>;

export type WorkspaceInstruction = Infer<typeof vWorkspaceInstruction>;

export type ArtifactType = Infer<typeof vArtifactType>;

export type ArtifactScope = Infer<typeof vArtifactScope>;
