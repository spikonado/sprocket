import type { LanguageModelUsage } from 'ai';

export const reasoningEffortIds = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const serviceTierIds = ['standard', 'fast'] as const;
export const modelIds = [
	'gpt-5.6-sol',
	'claude-opus-5',
	'claude-fable-5',
	'glm-5.3',
	'kimi-k3',
	'deepseek-v4-pro',
	'deepseek-v4-flash'
] as const;

export type SupportedModelId = (typeof modelIds)[number];
export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];
export type SupportedServiceTier = (typeof serviceTierIds)[number];
export type ModelProvider = 'openai' | 'anthropic' | 'zai' | 'kimi' | 'deepseek';

/** Removed from the catalog; kept so existing thread/run rows still validate. */
export const retiredModelIds = ['gpt-5.6-terra', 'gpt-5.6-luna', 'grok-4.5'] as const;
export const persistedModelIds = [...modelIds, ...retiredModelIds] as const;

type TokenUsageWeights = { input: number; cacheRead: number; cacheWrite: number; output: number };

type ModelDefinition = {
	id: SupportedModelId;
	label: string;
	provider: ModelProvider;
	/** Context budget exposed by the provider's coding-agent harness. */
	contextWindowTokens: number;
	/** Input-token count at which the harness automatically compacts. */
	autoCompactTokenLimit: number;
	reasoningEfforts: readonly SupportedReasoningEffort[];
	defaultReasoningEffort: SupportedReasoningEffort;
	serviceTiers: readonly SupportedServiceTier[];
	usageWeights: TokenUsageWeights & { fastMultiplier: number };
};

/** UI-facing model entry (server pricing weights omitted). */
export type CatalogModel = Omit<ModelDefinition, 'usageWeights'>;

const millionTokenContext = {
	contextWindowTokens: 1_000_000,
	autoCompactTokenLimit: 967_000
} as const;

const lowHighMaxReasoningEfforts = ['low', 'high', 'max'] as const;

export const modelDefinitions = [
	{
		id: 'gpt-5.6-sol',
		label: 'GPT-5.6 Sol',
		provider: 'openai',
		// OpenAI bills the whole request at 1M rates once input exceeds 272k.
		contextWindowTokens: 272_000,
		autoCompactTokenLimit: 258_000,
		reasoningEfforts: reasoningEffortIds,
		defaultReasoningEffort: 'medium',
		serviceTiers: ['standard'],
		usageWeights: {
			input: 0.005,
			cacheRead: 0.0005,
			cacheWrite: 0.00625,
			output: 0.03,
			fastMultiplier: 2
		}
	},
	{
		id: 'claude-opus-5',
		label: 'Claude Opus 5',
		provider: 'anthropic',
		...millionTokenContext,
		reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
		defaultReasoningEffort: 'high',
		serviceTiers: serviceTierIds,
		usageWeights: {
			input: 0.005,
			cacheRead: 0.0005,
			cacheWrite: 0.00625,
			output: 0.025,
			fastMultiplier: 2
		}
	},
	{
		id: 'claude-fable-5',
		label: 'Claude Fable 5',
		provider: 'anthropic',
		...millionTokenContext,
		reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
		defaultReasoningEffort: 'high',
		serviceTiers: ['standard'],
		usageWeights: {
			input: 0.01,
			cacheRead: 0.001,
			cacheWrite: 0.0125,
			output: 0.05,
			fastMultiplier: 1
		}
	},
	{
		id: 'glm-5.3',
		label: 'GLM 5.3',
		provider: 'zai',
		...millionTokenContext,
		reasoningEfforts: lowHighMaxReasoningEfforts,
		defaultReasoningEffort: 'max',
		serviceTiers: ['standard'],
		usageWeights: {
			input: 0.0014,
			cacheRead: 0.00026,
			cacheWrite: 0,
			output: 0.0044,
			fastMultiplier: 1
		}
	},
	{
		id: 'kimi-k3',
		label: 'Kimi K3',
		provider: 'kimi',
		...millionTokenContext,
		reasoningEfforts: lowHighMaxReasoningEfforts,
		defaultReasoningEffort: 'max',
		serviceTiers: ['standard'],
		usageWeights: {
			input: 0.003,
			cacheRead: 0.0003,
			cacheWrite: 0,
			output: 0.015,
			fastMultiplier: 1
		}
	},
	{
		id: 'deepseek-v4-pro',
		label: 'DeepSeek V4 Pro',
		provider: 'deepseek',
		...millionTokenContext,
		reasoningEfforts: lowHighMaxReasoningEfforts,
		defaultReasoningEffort: 'max',
		serviceTiers: ['standard'],
		usageWeights: {
			input: 0.00066,
			cacheRead: 0.00002,
			cacheWrite: 0,
			output: 0.00198,
			fastMultiplier: 1
		}
	},
	{
		id: 'deepseek-v4-flash',
		label: 'DeepSeek V4 Flash',
		provider: 'deepseek',
		...millionTokenContext,
		reasoningEfforts: lowHighMaxReasoningEfforts,
		defaultReasoningEffort: 'high',
		serviceTiers: ['standard'],
		usageWeights: {
			input: 0.00013,
			cacheRead: 0.00003,
			cacheWrite: 0,
			output: 0.00026,
			fastMultiplier: 1
		}
	}
] as const satisfies readonly ModelDefinition[];

export const defaultModelId = 'gpt-5.6-sol' as const;
export const defaultReasoningEffort: SupportedReasoningEffort =
	getModelDefinition(defaultModelId).defaultReasoningEffort;
export const defaultServiceTier = 'standard' as const;

export function getModelDefinition(modelId: SupportedModelId): ModelDefinition {
	const definition = modelDefinitions.find((model) => model.id === modelId);
	if (!definition) throw new Error(`Unsupported model: ${modelId}`);
	return definition;
}

/** Map a stored (possibly retired) model id onto the current catalog. */
export function coercePersistedModelId(modelId: string): SupportedModelId {
	return (modelIds as readonly string[]).includes(modelId)
		? (modelId as SupportedModelId)
		: defaultModelId;
}

export function normalizeCompletionUsage(usage: LanguageModelUsage): {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
} {
	const details = usage.inputTokenDetails;
	const cacheRead = details.cacheReadTokens ?? 0;
	const cacheWrite = details.cacheWriteTokens ?? 0;
	return {
		input: details.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite),
		cacheRead,
		cacheWrite,
		output: usage.outputTokens ?? 0
	};
}

export function completionUsageUnits(
	modelId: SupportedModelId,
	serviceTier: SupportedServiceTier,
	tokens: { input: number; cacheRead: number; cacheWrite: number; output: number }
): number {
	const { fastMultiplier, ...weights } = getModelDefinition(modelId).usageWeights;
	const multiplier = serviceTier === 'fast' ? fastMultiplier : 1;
	return Math.ceil(
		multiplier *
			(tokens.input * weights.input +
				tokens.cacheRead * weights.cacheRead +
				tokens.cacheWrite * weights.cacheWrite +
				tokens.output * weights.output)
	);
}

export function assertSupportedModelConfiguration(args: {
	modelId: SupportedModelId;
	reasoningEffort?: SupportedReasoningEffort;
	serviceTier: SupportedServiceTier;
}) {
	const model = getModelDefinition(args.modelId);
	if (
		args.reasoningEffort !== undefined &&
		!(model.reasoningEfforts as readonly SupportedReasoningEffort[]).includes(args.reasoningEffort)
	) {
		throw new Error(`${model.label} does not support ${args.reasoningEffort} reasoning.`);
	}
	if (!(model.serviceTiers as readonly SupportedServiceTier[]).includes(args.serviceTier)) {
		throw new Error(`${model.label} does not support the ${args.serviceTier} service tier.`);
	}
}
