export const reasoningEffortIds = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const serviceTierIds = ['standard', 'fast'] as const;
export const modelIds = [
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'gpt-5.6-luna',
	'claude-fable-5',
	'grok-4.5'
] as const;
export const legacyModelIds = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'] as const;
export const persistedModelIds = [...modelIds, ...legacyModelIds] as const;

export type SupportedModelId = (typeof modelIds)[number];
export type PersistedModelId = (typeof persistedModelIds)[number];
export type SupportedReasoningEffort = (typeof reasoningEffortIds)[number];
export type SupportedServiceTier = (typeof serviceTierIds)[number];
export type ModelProvider = 'openai' | 'anthropic' | 'xai';

type ModelDefinition = {
	id: SupportedModelId;
	label: string;
	provider: ModelProvider;
	reasoningEfforts: readonly SupportedReasoningEffort[];
	serviceTiers: readonly SupportedServiceTier[];
};

const standardReasoning = ['low', 'medium', 'high', 'xhigh'] as const;
const grokReasoning = ['low', 'medium', 'high'] as const;
const standardServiceTier = ['standard'] as const;

export const modelDefinitions = [
	{
		id: 'gpt-5.6-sol',
		label: 'GPT-5.6-Sol',
		provider: 'openai',
		reasoningEfforts: reasoningEffortIds,
		serviceTiers: serviceTierIds
	},
	{
		id: 'gpt-5.6-terra',
		label: 'GPT-5.6-Terra',
		provider: 'openai',
		reasoningEfforts: reasoningEffortIds,
		serviceTiers: serviceTierIds
	},
	{
		id: 'gpt-5.6-luna',
		label: 'GPT-5.6-Luna',
		provider: 'openai',
		reasoningEfforts: reasoningEffortIds,
		serviceTiers: serviceTierIds
	},
	{
		id: 'claude-fable-5',
		label: 'Fable-5',
		provider: 'anthropic',
		reasoningEfforts: standardReasoning,
		serviceTiers: standardServiceTier
	},
	{
		id: 'grok-4.5',
		label: 'Grok 4.5',
		provider: 'xai',
		reasoningEfforts: grokReasoning,
		serviceTiers: standardServiceTier
	}
] as const satisfies readonly ModelDefinition[];

export const defaultModelId = 'gpt-5.6-sol' as const;
export const defaultReasoningEffort = 'low' as const;
export const defaultServiceTier = 'standard' as const;

export function getModelDefinition(modelId: SupportedModelId): ModelDefinition {
	const definition = modelDefinitions.find((model) => model.id === modelId);
	if (!definition) throw new Error(`Unsupported model: ${modelId}`);
	return definition;
}

export function normalizeModelId(modelId: PersistedModelId): SupportedModelId {
	return (modelIds as readonly string[]).includes(modelId)
		? (modelId as SupportedModelId)
		: defaultModelId;
}

export function normalizeServiceTier(
	serviceTier: SupportedServiceTier | undefined
): SupportedServiceTier {
	return serviceTier ?? defaultServiceTier;
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
