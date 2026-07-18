import type { LanguageModelUsage } from 'ai';

export const reasoningEffortIds = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const serviceTierIds = ['standard', 'fast'] as const;
export const modelIds = [
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'claude-fable-5',
	'grok-4.5'
] as const;

export type SupportedModelId = (typeof modelIds)[number];
export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];
export type SupportedServiceTier = (typeof serviceTierIds)[number];
export type ModelProvider = 'openai' | 'anthropic' | 'xai';

type ModelDefinition = {
	id: SupportedModelId;
	label: string;
	provider: ModelProvider;
	reasoningEfforts: readonly SupportedReasoningEffort[];
	defaultReasoningEffort: SupportedReasoningEffort;
	serviceTiers: readonly SupportedServiceTier[];
	usageWeights: {
		short: TokenUsageWeights;
		long?: { minimumInputTokens: number; weights: TokenUsageWeights; fastMultiplier: number };
		fastMultiplier: number;
	};
};

type TokenUsageWeights = { input: number; cacheRead: number; cacheWrite: number; output: number };

export const modelDefinitions = [
	{
		id: 'gpt-5.6-sol',
		label: 'GPT-5.6 Sol',
		provider: 'openai',
		reasoningEfforts: reasoningEffortIds,
		defaultReasoningEffort: 'medium',
		serviceTiers: serviceTierIds,
		usageWeights: {
			short: { input: 0.005, cacheRead: 0.0005, cacheWrite: 0.00625, output: 0.03 },
			long: {
				minimumInputTokens: 272_001,
				weights: { input: 0.01, cacheRead: 0.001, cacheWrite: 0.0125, output: 0.045 },
				fastMultiplier: 1
			},
			fastMultiplier: 2
		}
	},
	{
		id: 'gpt-5.6-terra',
		label: 'GPT-5.6 Terra',
		provider: 'openai',
		reasoningEfforts: reasoningEffortIds,
		defaultReasoningEffort: 'medium',
		serviceTiers: serviceTierIds,
		usageWeights: {
			short: { input: 0.0025, cacheRead: 0.00025, cacheWrite: 0.003125, output: 0.015 },
			long: {
				minimumInputTokens: 272_001,
				weights: {
					input: 0.005,
					cacheRead: 0.0005,
					cacheWrite: 0.00625,
					output: 0.0225
				},
				fastMultiplier: 1
			},
			fastMultiplier: 2
		}
	},
	{
		id: 'gpt-5.6-luna',
		label: 'GPT-5.6 Luna',
		provider: 'openai',
		reasoningEfforts: reasoningEffortIds,
		defaultReasoningEffort: 'medium',
		serviceTiers: serviceTierIds,
		usageWeights: {
			short: { input: 0.001, cacheRead: 0.0001, cacheWrite: 0.00125, output: 0.006 },
			long: {
				minimumInputTokens: 272_001,
				weights: { input: 0.002, cacheRead: 0.0002, cacheWrite: 0.0025, output: 0.009 },
				fastMultiplier: 1
			},
			fastMultiplier: 2
		}
	},
	{
		id: 'claude-fable-5',
		label: 'Claude Fable 5',
		provider: 'anthropic',
		reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
		defaultReasoningEffort: 'high',
		serviceTiers: serviceTierIds,
		usageWeights: {
			short: { input: 0.01, cacheRead: 0.001, cacheWrite: 0.0125, output: 0.05 },
			fastMultiplier: 1
		}
	},
	{
		id: 'grok-4.5',
		label: 'Grok 4.5',
		provider: 'xai',
		reasoningEfforts: ['low', 'medium', 'high'],
		defaultReasoningEffort: 'high',
		serviceTiers: serviceTierIds,
		usageWeights: {
			short: { input: 0.002, cacheRead: 0.0005, cacheWrite: 0.002, output: 0.006 },
			long: {
				minimumInputTokens: 200_000,
				weights: { input: 0.004, cacheRead: 0.001, cacheWrite: 0.004, output: 0.012 },
				fastMultiplier: 2
			},
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
	const pricing = getModelDefinition(modelId).usageWeights;
	const totalInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	const longPricing =
		pricing.long && totalInput >= pricing.long.minimumInputTokens ? pricing.long : undefined;
	const weights = longPricing?.weights ?? pricing.short;
	const multiplier =
		serviceTier === 'fast' ? (longPricing?.fastMultiplier ?? pricing.fastMultiplier) : 1;
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
