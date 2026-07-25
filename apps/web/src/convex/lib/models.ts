import type { LanguageModelUsage } from 'ai';

export const reasoningEffortIds = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const serviceTierIds = ['standard', 'fast'] as const;
export const modelIds = [
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'claude-opus-5',
	'claude-fable-5',
	'grok-4.5'
] as const;

export type SupportedModelId = (typeof modelIds)[number];
export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];
export type SupportedServiceTier = (typeof serviceTierIds)[number];
export type ModelProvider = 'openai' | 'anthropic' | 'xai';

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

export const modelDefinitions = [
	{
		id: 'gpt-5.6-sol',
		label: 'GPT-5.6 Sol',
		provider: 'openai',
		contextWindowTokens: 258_400,
		autoCompactTokenLimit: 244_800,
		reasoningEfforts: reasoningEffortIds,
		defaultReasoningEffort: 'medium',
		serviceTiers: serviceTierIds,
		usageWeights: {
			input: 0.005,
			cacheRead: 0.0005,
			cacheWrite: 0.00625,
			output: 0.03,
			fastMultiplier: 2
		}
	},
	{
		id: 'gpt-5.6-terra',
		label: 'GPT-5.6 Terra',
		provider: 'openai',
		contextWindowTokens: 258_400,
		autoCompactTokenLimit: 244_800,
		reasoningEfforts: reasoningEffortIds,
		defaultReasoningEffort: 'medium',
		serviceTiers: serviceTierIds,
		usageWeights: {
			input: 0.0025,
			cacheRead: 0.00025,
			cacheWrite: 0.003125,
			output: 0.015,
			fastMultiplier: 2
		}
	},
	{
		id: 'gpt-5.6-luna',
		label: 'GPT-5.6 Luna',
		provider: 'openai',
		contextWindowTokens: 258_400,
		autoCompactTokenLimit: 244_800,
		reasoningEfforts: reasoningEffortIds,
		defaultReasoningEffort: 'medium',
		serviceTiers: serviceTierIds,
		usageWeights: {
			input: 0.001,
			cacheRead: 0.0001,
			cacheWrite: 0.00125,
			output: 0.006,
			fastMultiplier: 2
		}
	},
	{
		id: 'claude-opus-5',
		label: 'Claude Opus 5',
		provider: 'anthropic',
		contextWindowTokens: 1_000_000,
		autoCompactTokenLimit: 967_000,
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
		contextWindowTokens: 1_000_000,
		autoCompactTokenLimit: 967_000,
		reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
		defaultReasoningEffort: 'high',
		serviceTiers: serviceTierIds,
		usageWeights: {
			input: 0.01,
			cacheRead: 0.001,
			cacheWrite: 0.0125,
			output: 0.05,
			fastMultiplier: 1
		}
	},
	{
		id: 'grok-4.5',
		label: 'Grok 4.5',
		provider: 'xai',
		contextWindowTokens: 500_000,
		autoCompactTokenLimit: 400_000,
		reasoningEfforts: ['low', 'medium', 'high'],
		defaultReasoningEffort: 'high',
		serviceTiers: serviceTierIds,
		usageWeights: {
			input: 0.002,
			cacheRead: 0.0005,
			cacheWrite: 0.002,
			output: 0.006,
			fastMultiplier: 2
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
